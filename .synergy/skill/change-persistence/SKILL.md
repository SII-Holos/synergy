---
name: change-persistence
description: Add or modify Synergy durable state, JSON storage keys, SQLite tables, indexes, session/message fields, cache-versus-canonical ownership, migrations, recovery, import/export, or retention behavior. Use for packages/synergy/src/storage, domain migration files, Library database changes, persisted schemas, and compatibility cleanup.
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

### SQLite and other domain stores

1. Keep fresh-install schema creation in the owning database initialization.
2. Put upgrades, backfills, and rewrites in versioned domain migrations registered through the central migration runner.
3. Preserve transaction, WAL, vector-extension fail-soft, and backup assumptions of the owning store.

## Migrate Existing Data

1. Add a migration whenever an existing persisted shape can reach the new code.
2. Make the migration deterministic and idempotent. Record dependencies and ordering explicitly.
3. Migrate to one canonical current path, then remove obsolete runtime adapters where the migrated state makes them unnecessary.
4. Keep compatibility readers only at a named boundary when migration cannot make old data impossible; do not spread legacy checks through business logic.
5. Preserve secrets and owner-only permissions. Never log raw credentials or include them in diagnostics fixtures.
6. Build old-state fixtures from schemas emitted by shipped writers. Do not use a synthetic superset of multiple historical variants as the only upgrade fixture.

## Verify

Test:

- fresh state
- representative old state
- repeated migration execution
- partial/malformed input and recovery
- index/read consistency
- deletion/archival/import/export behavior
- startup runner execution and dependency ordering
- a clone or fixture of the latest released state for startup-blocking migrations

Use real temporary `SYNERGY_HOME`, Scope, storage, or SQLite fixtures instead of broad mocks. Run the narrow domain test, migration tests, recovery/integration tests, typecheck, and `bun run quality:quick`.

Update [Storage and paths](../../../docs/reference/storage-and-paths.md) for durable layout changes and the owning architecture document for new invariants. Keep historical narratives in `docs/migrations/`, not current-state docs.

## Handoff

Report canonical owner, key/table/schema changes, derived indexes, migration ID/order/idempotence, compatibility removed or retained, recovery/export impact, and tests.
