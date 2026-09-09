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

### File-backed JSON

1. Build logical keys through `StoragePath`; use `Storage` for locks, atomic writes, reads, scans, and removal.
2. Keep independently updated or streamed records independently addressable. Do not rewrite a whole session or collection for one leaf update.
3. Update derived indexes and events in the same owner transaction/lifecycle as the canonical write.
4. Preserve the atomic-write transient-retry contract: `Storage` write+rename retries `EPERM`/`EACCES`/`EBUSY` (classified by `isRetryableIOError`) so Windows sharing violations do not fail persistence, permanent errors fail fast, and temp files are removed (with the same transient retry) on the failure path. Do not bypass `Storage` with a bare rename; extend `test/storage/storage-retry.test.ts` when changing write-path failure behavior.
5. Authoritative rollout evidence uses private, durable Storage writes and the bounded `RolloutArtifact` stream store. Keep progress independently committed, verify content hashes, and preserve partial observations. Do not replace its persistence failures with diagnostic warnings, empty data, or successful completion; propagate `RolloutRecordingError` so execution admission can stop.

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
7. Validate the historical fields a migration reads or rewrites, and preserve unrelated metadata when updating the record. Use the full current schema only when upgrading the whole record to that schema. Include nullable historical fields, archived source metadata, and preservation of unknown fields in upgrade tests where those formats existed.
8. Inventory every record layer traversed by a startup-blocking migration, including nested message parts and attachments. Classify malformed historical input separately from storage failures: preserve the record and persist an explicit evidence gap when its original content cannot be recovered; keep permission, read/write and evidence-persistence failures fatal. Test both cases using real storage fixtures.
9. For independent scans within one migration, pass an increasing phase index to `progress(current, total, phase)`, beginning with `progress(0, 0, nextPhase)` before preparing the next scan. Keep counts monotonic within each phase and test phase transitions through the central runner; do not relax Desktop stale-progress rejection to accommodate raw counter resets.

## File Snapshot Storage

When changing snapshot Git commands, verify them with an actual supported older Git executable as well as the current version. Run the snapshot suites with that executable first on `PATH`; keep test homes isolated. Initialization must select and verify SHA-1 before publishing repository metadata, preserve existing objects, and retain exit code and stderr on failure. Avoid introducing a version-specific CLI option when the same operation has a compatible form.

Use `SnapshotStore` for backend resolution, `SnapshotLifecycle` for copied/deleted ownership, and `SnapshotMaintenance` for offline migration and collection. Hold the Scope lease for all object/ref transactions and the session lock for mutable indexes. Publish refs before message hashes; remove canonical session records before releasing their refs. Preserve every historical root across archive, transcript rollback, and message compaction. Full-data copies must use `SnapshotArchive` for snapshot directories, never generic copy-skip-existing. Rollout ZIP export/import uses its session-scoped object transfer under Scope leases; retain imported roots before publishing message references. Test packed refs, alternates without refs, unknown objects, checkpoint interruptions, and cross-process exclusion. Run `bun packages/product-runtime/script/benchmark-snapshots.ts` from the repository root for an isolated storage-backend comparison; distinguish that measurement from old-binary timing or production capacity estimates.

## Verify

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
