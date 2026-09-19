# Decision Record: Budgeted storage retention and incremental auto-vacuum

Status: implemented

## Problem

The authoritative Agent database (`agent.sqlite`) grew unbounded. Measured on a development host it reached ~5.2 GB with 1.68M records, of which 1.64M were Rollout evidence, and it grew roughly 17 GB/day. `auto_vacuum` was `0`, and nothing under `packages/harness/src/storage/` ever ran `VACUUM`, `incremental_vacuum` or `wal_checkpoint`, so deleted or rewritten pages were never returned to the filesystem. The Observability subsystem already solved this exact problem with `enableIncrementalVacuum`, `enforce` and `physicalFootprint`, but those lived in the observability domain and were never applied to the authoritative store.

The constraint that makes this non-trivial is SQLite's: `auto_vacuum` can only be set on an empty database, or afterwards only by `PRAGMA auto_vacuum=INCREMENTAL` followed by a full `VACUUM`. A 5 GB database therefore needs a real, progress-reporting migration rather than a pragma. The second constraint is product: Rollout evidence carries rewind, restore and replay semantics protected by [the durable rollout contract](2026-09-07-durable-rollout-execution-contract.md), so a retention pass that removes evidence for a session the user can still rewind would destroy recoverable state.

## Decision

The SQLite maintenance engine moves to the storage domain as `SqliteMaintenance` (from `observability/sqlite-maintenance.ts`) and is shared by both stores; Observability imports it instead of owning a second copy. This is one maintenance implementation with two callers, not a parallel mechanism.

**Incremental auto-vacuum.** The SQLite worker declares `PRAGMA auto_vacuum = INCREMENTAL` before `journal_mode = WAL` on every writable open. Ordering is load-bearing: SQLite records the mode in the database header while the file is still empty, so a new database must declare it before the WAL journal creates that header, and the pragma is inert on an existing non-empty database. Fresh installations are therefore incremental from the first write, with no migration.

An existing database converts through `StorageIncrementalVacuum`, a versioned migration registered in the owning storage domain (`20260918-storage-incremental-vacuum`) and run by the central migration runner. It is idempotent (returns `changed: false` when the database already reports `incremental`), reports progress through the runner's phase contract, and is a no-op for PostgreSQL, which keeps no in-file freelist. The `VACUUM` runs inside the existing SQLite worker over the existing `maintain` IPC action, so it never runs on the Control Plane event loop and cannot be interleaved with ordinary queries. If the process dies mid-`VACUUM`, SQLite leaves the previous database intact.

**Budgeted retention.** `storage.retentionMs` joins the existing performance storage block (`packages/harness/src/config/schema.ts`), resolved through `ObservabilityConfig.effective()` with the same default-merge pattern as `maxSqliteBytes`. The default is 7 days and the effective value is clamped to 1 hour–90 days; `0` disables retention entirely, so an operator can turn pruning off immediately. Retention is off unless the window is positive, and it only runs while the database is over `storage.maxSqliteBytes`.

Pruning is oldest-first over whole Rollout evidence trees (`sessions/<scope>/<session>/rollout`, `operations/<scope>/<op>/rollout`) and is subject to two protections evaluated before any delete:

- **Window protection.** An owner whose newest record is inside the window is never touched. Rollout writes a `journal/head` record on every logical write, so the newest record of an owner is an exact evidence-recency signal.
- **Live-session protection.** `SessionManager.liveSessionIDs()` returns every session holding a registered runtime, and the live set is re-read immediately before each delete so a session that starts mid-pass cannot be pruned. Operations have no runtime, so only the window protects them.

Two store primitives support this. `StoreTransaction.pruneTree(prefix)` removes a subtree physically, in contrast to the existing `removeTree`, which leaves a revision tombstone per record and therefore would not return any bytes; it deletes records and their node rows in dependency order and enqueues the same durable artifact-collection intent ordinary deletion uses. `TransactionalStore.evidenceOwners()` groups Rollout owners with `MAX(updated)` and a record count using JSON key extraction, reading only keys and timestamps so the scan is bounded by owner count rather than by how much evidence each owner holds.

`StorageRetention.schedule()` runs a pass every 15 minutes from `RuntimeHandle.open`, and `StorageRetention.stop()` runs first in runtime shutdown so a pass cannot outlive the store it prunes.

## Alternatives considered

**Apply the pragma at open time only, without a migration.** `PRAGMA auto_vacuum=INCREMENTAL` is silently inert on a non-empty database — the mode stays `0` — so an existing installation would keep the defect while fresh ones got the fix. A migration is required for the population that actually has the problem.

**Delete `storage_nodes` or Rollout records wholesale to stop growth.** The Blueprint explicitly rejects this: those records carry rewind, restore and replay semantics. Retention here is budget- and window-bounded and protects live sessions, rather than removing evidence indiscriminately.

**Put `retentionMs` in the storage bootstrap configuration (`StorageConfiguration`).** That file is `replace-domain` and explicitly not hot-reloadable: `Config.domainUpdate` rejects the `storage` domain, and the backend refuses to hot-reload a storage change. A retention switch an operator cannot turn off without restarting the runtime contradicts "immediately disableable". The performance storage block already resolves the byte budget that retention is measured against, so the window belongs beside it.

**Prune with the existing `removeTree`.** It writes a `NULL` body and bumps the revision for every record in the range. That is the correct contract for canonical deletion, where a delayed writer must not revive the row, but it returns no space and retains every row, so the byte budget could never be met.

**Reuse `SqliteMaintenance.enforce` for retention.** `enforce` deletes oldest rows until the physical footprint fits, with no notion of ownership, recency or liveness. Applying it to the authoritative store would remove Rollout evidence for live sessions. The shared module contributes the reclaim and conversion primitives; owner-level policy lives in `StorageRetention`.

**Run retention in a separate worker process.** A second process would need its own ownership of the SQLite file, which the single-owner server lock and `StorageOwnershipError` fencing deliberately prevent. The existing `maintain` path already isolates maintenance from the Control Plane event loop.

## Consequences

Existing installations pay one full `VACUUM` during the migration window; on a multi-GB database this is minutes, not seconds, and it happens once, before admission, with progress reported through the runner. Fresh installations pay nothing. PostgreSQL installs are unaffected: the migration reports nothing to do and retention never enumerates owners.

Reclamation is incremental and bounded — each retention pass releases at most a fixed number of freelist pages within a time budget — so the file shrinks toward the budget over several passes instead of jumping in one long transaction. Reclaim requires incremental auto-vacuum to have been applied first, which the migration guarantees; on a database still in `none` mode the reclaim is harmless but ineffective.

Retention is destructive and irreversible for pruned owners. The trade-off is bounded by the mandatory window gate (`packages/harness/test/storage/retention.test.ts`: evidence inside the window stays readable after a pass) and by the live-session protection, and it is reversible in the safe direction only — setting `retentionMs` to `0` stops further pruning but cannot restore pruned evidence. Because the default window is 7 days, an installation that upgrades and does nothing else will begin pruning evidence older than a week as soon as it exceeds the byte budget.

The `auto_vacuum` change itself is not rolled back by design: it does not affect correctness, and reverting it would only restore the unbounded-growth behavior.
