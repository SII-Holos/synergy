# Decision Record: Serialize plugin approval read-modify-write and migrate sibling stores to the shared atomic writer

Status: implemented

## Problem

Review of #1256 (marketplace registry fixed-`.tmp` race) surfaced the same hand-rolled pattern in two sibling plugin stores, one of them with a worse failure mode:

- `consent/approval-store.ts` stages `plugin-approvals.json` at a fixed `${file}.tmp` **and** performs an unsynchronized read-modify-write (`readAll` → transform → `writeAll`). Concurrent `saveApproval`/`removeApproval` calls (e.g. an install transaction racing a UI consent action) can interleave: one writer's `.tmp` content is clobbered or its `rename` hits `ENOENT` on a temp another writer already moved, and even a successful pair of renames can drop one writer's record because both computed their batch from the same pre-state. `plugin-approvals.json` is authoritative consent state, not a TTL cache, so a lost update silently revokes or mis-attributes capability grants.
- `incompatible-store.ts` has the same fixed-`.tmp` staging for `plugin-incompatible.json`; concurrent writes race identically (torn batch or `ENOENT`).

## Decision

Both stores delegate persistence to `Storage.writeJsonAtomic` (unique temp names, transient-IO retry, terminal-failure cleanup), matching the marketplace registry migration in #1256 and the `writeJsonAtomic` retry decision from #1247/#1248.

For the approval store, the whole read-modify-write (`saveApproval`, `removeApproval`, and the exported `writeApprovals`) now holds `Lock.write` on the store path, serializing in-process mutations so each batch is computed from the previous batch's committed state. `writeAll` itself stays lock-free because `Lock` is not reentrant; the exported `writeApprovals` (used by installation-transaction rollback, which restores a previously read snapshot rather than merging) takes the lock around the delegation. Out-of-process writers are not serialized — the installation lock in `installation-transaction.ts` is the existing cross-process serialization point for install flows that mutate both stores.

The incompatible store keeps its explicit `data` parameter (its only concurrent-write callers are serialized by the installation lock) and gains unique-temp atomicity without additional locking.

## Alternatives considered

- **Only swap the writer, no lock** — rejected for approvals: unique temp names remove the torn file and `ENOENT`, but the lost-update window of two racing read-modify-writes remains, which is the authoritative-state hazard.
- **Migrate both stores onto `Storage.write/update` keyed storage** — rejected: their files live at fixed paths under `Global.Path.data` (not key-array-addressed), and `Storage.write`'s key semantics would change file locations and retry/metric behavior beyond this fix's scope.
- **Cross-process file lock on `plugin-approvals.json`** — rejected: the only cross-process mutation flows already hold the plugin installation lock; adding a second locking subsystem repeats the tradeoff rejected in the #1247 decision record.

## Consequences

Concurrent approval mutations now serialize in-process and always land a complete, non-torn batch; rollback snapshots written by `writeApprovals` can no longer interleave with a concurrent `saveApproval`'s partial-state read. Both files gain the Windows transient-retry behavior for free. In-process contention on `plugin-approvals.json` was already bounded by install/consent flows being rare. Behavioral coverage: `test/plugin/approval-store.test.ts` (concurrent save/remove keeps every record, no temp residue) and the concurrent-write case in `test/plugin/incompatible-store.test.ts`; the new tests fail on the pre-fix code with the exact `ENOENT`/lost-update symptoms described above.
