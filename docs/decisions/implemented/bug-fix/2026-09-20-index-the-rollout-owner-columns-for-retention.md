# Decision Record: Index the rollout owner columns and stop selecting `key_text` in the retention scan

Status: implemented

## Problem

[Retention maintenance stalled the live writer](../../../postmortem/0019-retention-maintenance-stalled-the-live-writer.md) was fixed by giving every holder of the serialized writer an admission slot, by splitting the authoritative byte budget from the observability budget, and by measuring the queues. That fix made the pass _reachable_; it did not make the owner scan cheap.

`TransactionalStore.evidenceOwners()` resolves, for every rollout owner, the timestamp of its newest record. Retention calls it once per pass, and only when the store is already over its byte budget. The statement grouped `storage_records` by `scope_id` and `session_id` and selected `MIN(key_text)`, `MAX(updated)` and `COUNT(*)`.

[The residual storage simplification](../simplification/2026-09-20-retire-scope-index-and-read-transaction-wrapper.md) retired the `storage_records_scope` index and recorded that it claimed **no** regression for this statement, on the reasoning that the `kind`-led index also covers the `kind` prefix. That reasoning was correct about _which index the planner picks_ and wrong about _what the statement costs_. Measured on a copy of a production store — 11,223,279 live rollout rows, 157 owners, no `sqlite_stat*` tables because nothing in the repository ever ran `ANALYZE`:

| Shape                                                            | Plan                                                                                                                | Time                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| As shipped                                                       | `SEARCH storage_records USING INDEX storage_records_kind (namespace=? AND kind=?)` + `USE TEMP B-TREE FOR GROUP BY` | 251.39 s / 164.19 s        |
| Add the owner index, statement unchanged (still `MIN(key_text)`) | `SEARCH storage_records USING INDEX storage_records_owner (namespace=? AND kind=?)`                                 | 153.53 / 128.25 / 123.24 s |
| **Add the owner index and drop `MIN(key_text)`**                 | `SEARCH storage_records USING INDEX storage_records_owner (namespace=? AND kind=?)`                                 | **1.76 / 1.14 / 1.16 s**   |

The index is necessary and nowhere near sufficient. `key_text` is not an index column, so selecting it forces a table walk for every one of the 11.2M rows the group visits; that walk, not the group, is the 123-153 s. Removing the aggregate is what takes the statement to seconds, and it only does so once the owner columns are indexed.

The window between those two facts is a correctness window, not only a performance one. The statement runs on the single serialized reader lane the whole process shares, against a worker that handles requests on one synchronous message handler, so every second it takes blocks every read and write in the instance. It also outlasts the driver's ordinary 30 s request deadline, which puts it on the path that runs the liveness probe and can declare the store terminally unavailable.

## Decision

**Owner enumeration reads the owner columns under an index that carries them, and never selects `key_text`.**

`storage_records_owner` is `(namespace, kind, scope_id, session_id, updated) WHERE body IS NOT NULL`. The rollout statement becomes `SELECT scope_id, session_id, MAX(updated) AS newest, COUNT(*) AS records ... GROUP BY scope_id, session_id`, so every column it touches is in the index and SQLite resolves `MAX(updated)` per owner by seeking rather than by materialising a temporary b-tree. `COUNT(*)` stays: measured alongside `MAX` it is inside the same envelope (1.10-1.28 s for `MAX` alone), so `Owner.records` keeps its meaning and its consumers.

The owner prefix is then **built** from the two indexed columns — `["sessions", scope_id, session_id, "rollout"]` — instead of being sliced out of a `key_text` the statement no longer reads. That is the same path `StoragePath.sessionRolloutRoot` composes, and a test asserts the two agree, because the prefix is what retention hands to `pruneTree` and a mismatched prefix would delete a different subtree than the one that was measured.

**A rollout row whose owner columns are empty is not an owner.** The key-text form kept such a row whenever its key happened to be four segments long, and would have pruned through a prefix reconstructed from segments that do not name a session. Empty columns mean the row cannot be addressed as a session's rollout evidence, and leaving irreversible evidence alone is the safe direction.

The partial predicate is deliberate: tombstones (`body IS NULL`) are excluded from a write-maintained index. On the same synthetic store the replacement index measured **42.49 MiB** against the retired `storage_records_scope` at 66.25 MiB, and the retired index is gone, so the store's write path carries **less** index maintenance than it did before that index was retired.

**Both the open path and the migration create it, from one definition.** The open path iterates the schema array; `20260920-storage-records-owner-index` runs the identical statement constant for stores whose schema already ran. `CREATE INDEX IF NOT EXISTS` makes it a no-op on a fresh install and makes a re-run after an interrupted build converge.

**An index build runs on the maintenance deadline.** `CREATE INDEX` over an existing store reads every record — ~110 s on the 34 GB store. On the ordinary 30 s request deadline it is killed, rolled back, and then repeated on the next open, because the index is still missing; the store would fail to open for as long as the build takes to exceed the deadline. Schema DDL therefore declares `maintenance`, which routes it through the deadline formula the store already uses for integrity checks. `CREATE TABLE` deliberately stays on the ordinary deadline: it is a no-op once the table exists.

The rollout statement keeps no `maintenance` declaration of its own. After this change it measures seconds against a 30 s deadline, and widening its deadline would lengthen how long a genuinely dead worker goes undetected — the reason `PROBE_TIMEOUT_MS`, `PROBE_ATTEMPTS` and `failTerminal` are untouched.

**A failed retention pass reports itself.** The scheduler's `catch` logged and discarded, so a pass that never completed left the store silently over budget while the tick repeated the same work. It now raises `STORAGE_RETENTION_PASS_FAILED` alongside the log line, matching what the reachability guard already does for the neighbouring condition.

## Alternatives considered

**Keep the statement as it is and rely on the `kind`-led index.** This is what the store shipped with, and its plan reads well — the `kind` prefix is covered, so the group is not a full scan. The measurement is what refutes it: the `kind` index carries `order_key` after `kind`, not `scope_id` or `updated`, so the group still needs a temporary b-tree, and `MIN(key_text)` still forces a table walk. 164-251 s is that shape's real cost.

**Add the owner index and leave `MIN(key_text)` in place.** The natural reading of "the statement has no usable index" is "add the index". Measured, that is 123-153 s — better by 1.3-1.8x and still a two-minute stall of every read and write in the process, every 15 minutes. It is the more tempting change because it looks complete and it is the one the plan output confirms. It was rejected on the numbers, not on principle.

**Recover `key_text` from somewhere cheaper instead of dropping it.** `storage_nodes` stores the same key text per prefix, so the owner prefix could be read from there. It would trade one per-row lookup for another, in a table that has no index on the rollout ordering, and it would make the enumeration depend on a second table's consistency with the first. Building the prefix from the owner columns the statement is already grouping by is exact and free.

**Enumerate owners by seeking `order_key = 'head'` instead of grouping.** The journal writes a `head` record per session, so the head set looks like a per-owner index. Two facts refute it. `head.updated` is not the owner's newest timestamp — measured, the two differ by up to 103 ms — and the difference is structural, not incidental: `RolloutArtifact.open()` and `flush()` write through `Storage.write` without going through `journal.write`, from callers in `rollout/call.ts`, `rollout/transport-recorder.ts`, `rollout/process.ts`, `session/input.ts`, `rollout/tool.ts` and `rollout/migration.ts`; and `removeTree`'s tombstone updates write `updated = Date.now()` for every live record in the subtree without touching the head record at all. The head is a lower bound on recency. Pruning is irreversible and is gated on recency, so a lower bound would delete evidence inside the retention window.

**Keep the retired `storage_records_scope` index and add `ANALYZE` so the planner prefers it.** Measured, the planner picks the new index with **no** statistics present, so `ANALYZE` is not what makes this work. The `scope` index orders by `updated` while every production read orders by `order_key`, and it carries no `session_id`, so it could not serve the owner group even with statistics. It stays retired.

**Force the plan with `INDEXED BY storage_records_kind`.** Measured on the production-shaped store at 168.84 s — worse than the shape it would replace, because the forced index still needs the temporary b-tree and still walks the table for the columns it does not carry.

**Run a statement-count or SQL-text check to decide the deadline.** Both replace a fact the caller knows with a guess, and both would have to be re-derived on every edit. The schema array knows which of its statements are index builds.

## Consequences

Owner enumeration on the measured store went from 164-251 s to 1.14-1.76 s, and its plan is a single seek with no temporary b-tree and no table access. A retention pass that previously blocked every read and write in the instance for minutes, and exceeded the request deadline that gates terminal failure, now costs seconds.

The store keeps an index whose key carries the three owner columns and the recency it groups by, and no longer reads `key_text` for this statement. Because the retired `scope` index was larger than its replacement and is gone, the write path maintains less index than before — on a hot rollout path that writes continuously.

The cost is a new write-maintained index. It is partial on `body IS NOT NULL` to keep tombstoned rows out, and a benchmark (`bun packages/harness/script/benchmark-storage.ts`, the `storage-owners` line) measures enumeration, point-read and page cost against a rollout-shaped namespace so a reintroduced per-row table walk shows up as a number rather than as a plan that still reads well.

`evidenceOwners()` still returns nothing on PostgreSQL, for the reason it always did: that backend has no in-file freelist and no incremental reclaim, so retention has no budget to defend there and never enumerates. On SQLite, `scope_id` and `session_id` are populated for every rollout row the write path produces, and a test covers the empty-column case rather than assuming it away.
