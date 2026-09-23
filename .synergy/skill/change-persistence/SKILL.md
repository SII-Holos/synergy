---
name: change-persistence
description: Add or modify Synergy durable state, JSON storage keys, SQLite tables, indexes, session/message fields, cache-versus-canonical ownership, migrations, recovery, import/export, or retention behavior. Use for packages/harness/src/storage, domain migration files, Library database changes, persisted schemas, and compatibility cleanup.
---

# Change Persistence

## Classify the State

1. Decide whether the data is canonical durable state, a derived index/snapshot, cache, auth secret, runtime lock, temporary artifact, or project-local configuration.
2. Read [Storage and paths](../../../docs/reference/storage-and-paths.md) and the owning architecture document.
3. Trace every writer, reader, index, event, export/import path, recovery path, deletion path, and startup migration before changing the shape.

## Implement the Current Model

### Authoritative Agent records

1. Build logical keys through `StoragePath`; use an explicit `Storage.Handle`. Normal Agent record code must never read or write legacy JSON files.
2. Keep independently updated or streamed records independently addressable. Wrap the complete business mutation, indexes, receipts and outbox notifications in `Storage.transaction()`.
3. Nested writes join the caller's transaction. Defer cache and event effects until commit. Never run tools, network calls, plugin reloads, filesystem writes or buffer drains inside a retryable SQL transaction. Keep transaction-owned part writes out of streaming retry buffers; verify rollback followed by a delivery retry cannot resurrect the abandoned parts.
4. Treat commit uncertainty as an unresolved result; reconcile the operation receipt before retrying. Preserve storage, ownership and integrity errors instead of treating them as missing records.
5. Call `Storage.writeBinary()` before entering `Storage.transaction()`; it rejects in-transaction calls because filesystem bytes must become durable before the business reference commits. Stage unpublished large imports and register resumable post-deletion cleanup. Rollout evidence commits its sequence allocation, event evidence, projection and head in one transaction.
6. Physical writes retain the atomic-file transient-retry contract for Windows sharing violations. Extend the real-file retry tests when changing that helper.
7. Keep the SQLite subprocess alive through owner process-group cancellation so terminal evidence can drain. Verify real `SIGINT`/`SIGTERM` delivery to an isolated owner group and forced owner loss; explicit shutdown, request deadlines and parent-disconnection cleanup must still terminate the worker.
8. Run the shared SQLite/PostgreSQL contract tests for engine changes; CI requires real PostgreSQL 16–18. macOS source development needs the verified SQLite engine from `bun packages/harness/script/build-sqlite.ts`. For engine packaging changes, run `bun test --config /dev/null test/script/release/workspace-sqlite.test.ts` on macOS to open the actual unpacked archive with host libraries masked.
9. Inspect real query plans for early and late cursor pages when changing large imports, verification or export. Verify index range seeks, tied ordering, descending pages, deleted cursors and namespace isolation. Prefix traversals must probe records from their descendant frontier; include an absent recovery root against a populated namespace so an empty result cannot hide a full scan. Child enumeration must short-circuit after live evidence in each immediate child rather than walk every historical descendant; verify deleted-only and foreign-namespace branches remain hidden. Full maintenance walks use the existing key index; measure the space cost before adding another per-record index. Keep physical integrity checks complete and size their finite maintenance budget from the current database snapshot, including WAL growth; never relax ordinary query deadlines to cover offline verification.
10. Route every long SQLite operation through typed driver maintenance (`vacuum`, `reclaim`, `integrity-check`, `create-index`, `drop-index`), including schema DDL during first open. Do not add caller-specific startup timers or budget callbacks. Verify the real operation emits begin and exactly one terminal event; preserve finite snapshot budgets, bounded worker probes, failure propagation and PostgreSQL behavior. Read the [startup maintenance contract](../../../docs/decisions/implemented/bug-fix/2026-09-20-startup-maintenance-contract.md) when adding an operation.
11. Audit direct SQL observers and cross-language test probes when changing record encoding. Prefer the canonical storage reader; isolated probes that must inspect a running container's private database must decode both plain and compressed bodies and retain a real-container regression.

Background maintenance may update session metadata without representing conversation activity. Carry the owning session mutation's activity-preservation option through cleanup helpers, retaining canonical activity timestamps as well as navigation `lastActivityAt` while publishing changed metadata. Test normal reclamation, missing-resource reconciliation and navigation index reconstruction with real session records, and verify new conversation activity still advances recency.

When changing worker liveness or shutdown, close a real worker while a blocking query has entered its busy state. Verify probing exits within the teardown budget and deliberate shutdown emits no terminal-unavailability notification. Recheck driver and request ownership after awaited probes; a closed driver can make retries resolve immediately and starve shutdown timers.

### SQLite and other domain stores

1. Keep fresh-install schema creation in the owning database initialization.
2. Put upgrades, backfills, and rewrites in versioned domain migrations registered through the central migration runner.
3. Preserve transaction, WAL, vector-extension fail-soft, and backup assumptions of the owning store.

## Migrate Existing Data

Register optional session fields, creation/import hooks and indexes through the owning package’s `session-schema.ts` before runtime startup. Keep the persistence reader tolerant of unloaded fields while public schemas expose only installed owners. Workflow session migrations stay with Workflows and preserve their historical `session` tracking ledger; moving ownership must not replay or discard migration history.

1. Add a migration whenever an existing persisted shape can reach the new code.
2. Make the migration deterministic and idempotent. Record dependencies and ordering explicitly.
3. Migrate to one canonical current path, then remove obsolete runtime adapters where the migrated state makes them unnecessary.
4. Keep compatibility readers only at a named boundary when migration cannot make old data impossible; do not spread legacy checks through business logic.
5. Preserve secrets and owner-only permissions. Never log raw credentials or include them in diagnostics fixtures.
6. Build old-state fixtures from schemas emitted by shipped writers. Do not use a synthetic superset of multiple historical variants as the only upgrade fixture.
7. Validate the historical fields a migration reads or rewrites, and preserve unrelated metadata when updating the record. Use the full current schema only when upgrading the whole record to that schema. Include nullable historical fields, archived source metadata, and preservation of unknown fields in upgrade tests where those formats existed. Index reconstruction must honor earlier archival migrations that deliberately retain retired fields: preserve canonical history, project only supported routing identities, and keep unexpected active retired identities fatal.
8. Inventory every record layer traversed by a startup-blocking migration, including nested message parts and attachments. Classify malformed historical input separately from storage failures: preserve the record and persist an explicit evidence gap when its original content cannot be recovered; keep permission, read/write and evidence-persistence failures fatal. Test both cases using real storage fixtures.
9. For independent scans within one migration, pass an increasing phase index to `progress(current, total, phase)`, beginning with `progress(0, 0, nextPhase)` before preparing the next scan. Keep counts monotonic within each phase and test phase transitions through the central runner; do not relax Desktop stale-progress rejection to accommodate raw counter resets.

When metadata upgrades run on access, audit projection builders as well as ordinary record readers. Apply registered owner upgrades before current-schema validation; a global migration receipt does not prove every lazy owner is current. Reproduce an already-completed projection migration that persisted an empty or partial index, reopen the Runtime through normal startup, and verify a new versioned repair restores it. Cover mixed upgraded and untouched owners, preserved activity and unknown fields, transactional rollback, and deferred-owner isolation without reading history.

Recovery indexes must stay absent or untrusted until a complete recovery pass establishes their baseline. Exercise migration-time writes before that first pass with unrelated historical owners; a new write must not create a partial index that hides older work. Re-arm a clean-shutdown index only after execution drains and transport shutdown succeed.

Deferred imports participate in the complete central migration graph. Mark an owner-local migration explicitly and test its `upSession` callback against unrelated owners; leave Scope-wide or unclassified work behind the staging barrier. Never mark a domain ledger complete before the discovered cohort converges. Import before entering a business transaction, recover before publishing the owner, and keep recovery baselines untrusted while old owners are unresolved. Keep catalog projections out of canonical index writers and drain Handle-owned background work before shutdown. Verify default eligibility from historical ledgers, retry fairness, first new work, first old-session access and interrupted retirement.

For segmented backups, test durable source freezing, missing/replaced source identity, independently sealed owner segments, incomplete-cohort restoration and a second import after business rollback. A frozen source is necessary recovery input until all segments seal; never describe the unfinished backup as independently portable. Verify original bytes against the seal before import and before retirement. Preserve old manifest protocols when resuming.

## File Snapshot Storage

When changing snapshot Git commands, verify them with an actual supported older Git executable as well as the current version. Run the snapshot suites with that executable first on `PATH`; keep test homes isolated. Initialization must select and verify SHA-1 before publishing repository metadata, preserve existing objects, and retain exit code and stderr on failure. Avoid introducing a version-specific CLI option when the same operation has a compatible form.

Use `SnapshotStore` for backend resolution, `SnapshotLifecycle` for copied/deleted ownership, and `SnapshotMaintenance` for offline migration and collection. Hold the Scope lease for all object/ref transactions and the session lock for mutable indexes. Publish refs before message hashes; remove canonical session records before releasing their refs. Preserve every historical root across archive, transcript rollback, and message compaction. Full-data copies must use `SnapshotArchive` for snapshot directories, never generic copy-skip-existing. Rollout ZIP export/import uses its session-scoped object transfer under Scope leases; retain imported roots before publishing message references. Test packed refs, alternates without refs, unknown objects, checkpoint interruptions, and cross-process exclusion. Run `bun packages/product-runtime/script/benchmark-snapshots.ts` from the repository root for an isolated storage-backend comparison; distinguish that measurement from old-binary timing or production capacity estimates.

For snapshot lease changes, test metadata-gate contention separately from active lease contention. Hold both the Home and Scope gates past a short internal wait, check the single admission budget and cancellation reason, and verify that disposal and failed exclusive admission remove their tokens even after admission expires or is cancelled. Keep cleanup independent of admission cancellation; never reclaim a live owner merely because it is old.

## Verify

For hierarchical deletion, measure missing-key and batched-key cleanup beside a large unrelated namespace, and inspect real engine plans for namespace-only probes. Distinguish records, derived nodes and artifact references when admitting online retention. Exercise wide trees, deep ancestors, a newly active owner, a refreshed record and cancellation after deletion begins; a count of deleted records cannot establish that a bounded node traversal is exhausted. Pair SQLite format 2/3 fixtures with PostgreSQL. Keep whole-owner offline deletion atomic and require exclusive ownership after closing runtime admission.

For storage queues and worker changes, hold the preceding operation past the waiter's deadline and verify it never executes later. Check inherited cancellation, caller context and shutdown drain. Suspend or terminate owned reader and writer processes independently; two connections in a shared synchronous process do not establish read availability. Preserve the distinct ordinary-work and maintenance budgets.

Bound batch writes by encoded parameter bytes as well as row count. Use real-engine fixtures with several individually valid large records, and verify a later failure rolls back every statement and its migration checkpoint.

For packed Agent evidence, measure logical bytes, filesystem allocation and unique file identities separately; backup-to-artifact hard links count once in migration peaks. Exercise independently readable backup restoration, interrupted chunk publication and retirement, source drift, corrupted final manifests, capacity exhaustion, legacy SQL format upgrades and SQLite/PostgreSQL locators. Keep source deletion after target verification. Test collection against a concurrent verification snapshot, unpublished orphan recovery and deletion fencing; a shared pack may be removed only after its last reference disappears. Run portable pack/merge/move and long completed/cancelled/failed Rollout streams. Calibrate the actual implemented layout on representative data; do not present a synthetic alternative schema's size as deployed savings.

For snapshot capacity work, measure filesystem allocation separately from logical bytes and count legacy/shared owners. Pilot one repository before bulk maintenance; the filter must cover registration as well as execution. Include required historical roots in the transfer inventory; a successful Git object read does not prove that its virtual empty tree is stored on disk. Preserve exact object IDs, historical tree listings and reconstructed file bytes across packing, migration and non-pruning compaction. Keep inventories on disk and verify staged packs before publication; large object transfers must preserve producer and indexer failures, source recoverability, and temporary-file cleanup; inject actual corrupt output and test a clean retry. Exercise a publication failure before the owner switch, including all sources in a bounded publication batch. Persist the staged reference inventory independently of the per-source object inventory so older Git can flush every reference. When consolidating legacy shared pools, preserve unowned borrowers, original refs and unclassified artifacts; flush the relative alternate only after all pool objects are retained in the shared store. Test partial cleanup, residual import keeps, relocation and full-archive materialization. Treat reclaimed session records as ownership evidence; a reclaimed Scope name alone must not bypass or prevent migration. Legacy packing must remain usable before SQL bootstrap and must refuse to rewrite a source covered by an interrupted backup. Keep bulk reference publication durable before removing any loose reference or legacy source, including on Git versions without reference fsync; see [snapshot architecture](../../../docs/architecture/workspace-and-files.md#snapshots-rollback-and-restore).

Test:

- fresh state
- representative old state
- repeated migration execution
- partial/malformed input and recovery
- index/read consistency
- deletion/archival/import/export behavior
- reduced compositions reading and updating records with unregistered owner fields, followed by transcript/rollout export, import, and owner reactivation; keep tolerant persistence schemas separate from public API schemas when the wire contract must remain fixed
- configuration and migration registration before runtime ownership; startup seals both registries, failed late imports cannot partially install schemas, and unregistered domains retain their data and tracking history
- detached migration listings and original contribution arrays cannot mutate the registered migrations; cleanup uses explicit registry APIs before startup
- startup runner execution and dependency ordering
- a clone or fixture of the latest released state for startup-blocking migrations

Use real temporary `SYNERGY_HOME`, Scope, storage, or SQLite fixtures instead of broad mocks. Run the narrow domain test, migration tests, recovery/integration tests, typecheck, and `bun run quality:quick`.

Update [Storage and paths](../../../docs/reference/storage-and-paths.md) for durable layout changes and the owning architecture document for new invariants. Keep historical narratives in `docs/migrations/`, not current-state docs.

## Handoff

Report canonical owner, key/table/schema changes, derived indexes, migration ID/order/idempotence, compatibility removed or retained, recovery/export impact, and tests.

Recovery discovery should query the indexed record kind before reading candidate owners. Do not scan every historical Session for a usually absent inbox or recovery intent. When relocating recovery authority to an indexed kind, migrate old intents transactionally through the registered runner; test fresh writes, repeated upgrade, and eventual execution without newly queued work.

When a recovery domain permits skipping malformed bodies, page over indexed identities before decoding so an entirely corrupt page cannot hide later valid work. Preserve bounded batch reads for healthy data, log isolated failures, and test unreadable candidate owners as well as records. Query and store-availability failures must still propagate; do not make ordinary authority reads silently tolerant.

Replay committed journal evidence in bounded reads at a captured revision. Test order, gaps and corruption across batch boundaries; reducing read transactions must preserve per-event validation and must never replay tools or provider calls.

## Historical preparation verification

Use a released writer fixture and its actual completion ledger when changing migration eligibility; deriving the fixture ledger from the current registry hides newly introduced barriers. Verify the qualified dependency graph before executing work. Keep unpublished owners behind the central SQL admission fence, and publish derived indexes with the admission marker in one transaction. Test source drift, publication rollback, process reopen, pinned-pack garbage collection and copied-backup recovery without the original Home. A Git fixture must exercise real absolute alternates and empty repository directories.

Include historical tool output or attachments that must become binary evidence, both on demand and during startup recovery. Verify that migration access can create and reuse evidence while ordinary reads and writes remain blocked until publication; check exact bytes and absence of duplicates after restart. Hold a real import at a storage checkpoint to test preparation polling during a retry with a persisted prior error, then assert its settled status. Cover both retryable errors and integrity errors without bypassing quarantine.

Keep foreground preparation distinct from background controls. Never pause a job while it holds a lease needed by foreground work: cancel through its durable checkpoint and release the lease before retrying. Report runtime readiness, historical convergence and independent backup completeness independently. Full VACUUM belongs to an explicit maintenance window; necessary long engine operations must expose their finite budget, with duplicate announcements unable to renew it.

Classify each newly registered migration against the released completion ledger. A global-record conversion may run at startup only when its deferred-owner effects are covered by owner-local migrations; verify both the global metadata and the preserved owner state while unrelated history remains pending.

For resumable multi-table rewrites, test capacity preflight with metadata-heavy fixtures at the initial phase and an intermediate phase. Count every table still ahead of the cursor, not only the table currently being copied. When combining storage migrations, verify both released-writer startup admission and deferred maintenance dependencies: a format rewrite must not accidentally stage all historical owners or run before its prerequisite conversion.

When adding a bulk variant of a storage operation, exercise every supported namespace encoding and a batch boundary. Preserve admission, revision fences, rollback, and structural cleanup from the single-record path; successful SQL execution alone does not prove that encoded keys matched rows.

For optional whole-store rewrites, prove ordinary startup never calls the rewrite even when prerequisite maintenance is already applied. Keep the atomic format commit separate from physical reclamation and reconcile a committed format with an absent migration receipt through a read-only probe. Persist every copy cursor in its batch transaction. If normal writes can occur between attempts, invalidate staged copies on source mutations before allowing a later swap; rebuild unfenced historical staging. Test updates, inserts, deletion, source drift, rollback, cancellation, reopening, and a second namespace. Background reclamation must yield to work and disk/WAL pressure, persist pause and progress, back off failures, and drain before storage closes.

## Preserve File History Attribution

Snapshot and patch producers retain the source Workspace identity and binding generation. Derived summaries group those sources before comparing trees; current Session selection must not rewrite historical file ownership. Use literal, NUL-delimited Git filenames and object-store working directories for history-only reads. Exercise non-Git capture, missing directories, rebindings and equal relative filenames in different Workspaces.

Restoration must hold the Session loop until native mutations and cancellation drain. Capture file entry and byte evidence before write admission, preflight every original binding before changing any file, and report partial results without retrying a user prompt automatically. Transfer all historical Workspace references, including message summaries; an imported ID without metadata must never resolve through a local record. Test missing provenance, rebindings, multiple historical roots, external links, newer queued writes, partial publication, binary bytes and Session cancellation.

Recover operation evidence through its existing durable owner discovery, including completed tools whose descendants outlive the tool response. Test without a Scope context, repeated recovery, immutable completed records and fork/import detachment. Never recapture the current filesystem as a crashed operation's historical endpoint.

Whole-Home imports must apply Workspace authority rules to catalog records and every known owner's references, including summaries, cursors and scheduled origins. Exercise ID collisions with a bound local Workspace, absent metadata, legacy directories and repeated imports. Keep unknown owner data and immutable evidence unchanged; validate original archive checksums and publish transformed metadata with its indexes atomically.

For trusted Home relocation, verify source host and physical directory identity before granting the destination namespace access. Test external and Home-local bindings, changed physical identity, existing target locations, remapped shared grants, repeated moves and path aliases. Advance moved binding generations without rewriting historical evidence; relocate only each owner’s known path fields. Native copies retain dangling file/directory/junction kinds and never traverse destination links.
