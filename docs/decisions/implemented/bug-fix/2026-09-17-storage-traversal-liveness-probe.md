# Decision Record: Probe traversal liveness by record key instead of scanning the namespace

Status: implemented

## Problem

A long-running workspace became unusable: switching sessions or sending a message froze the interface for tens of seconds, and the frontend's 5 s session-switch watchdog expired on 63 of 74 attempts. The dev log and the indexed observability store for the failing window recorded 606,429 storage operations in about 55 minutes, with `storage.operation.duration` tails of 17.2 s (`read`), 11.1 s (`scan`) and 9.4 s (`readMany`), while `process.event_loop.lag` stayed under 23 ms and CPU stayed under one core. The delay was queue wait on the single serialized storage reader queue, not blocked JavaScript. Reported as issue #1403.

[Agent storage](../../../architecture/agent-storage.md) owns the read path. `TransactionalStore.scan` and `list` joined the recursive key traversal against `storage_records` with `record.key_id = tree.key_id AND record.namespace = ? WHERE record.body IS NOT NULL`. SQLite planned that terminal join as `SEARCH storage_records USING INDEX storage_records_kind (namespace=?)`, so every call read the namespace-wide covering index — 89,445 live records in the reported store — regardless of subtree size. The frontier-driven recursion into `(namespace, parent_id)` is correct and already documented; the liveness filter was never covered by it.

Measured on that store with the old statements, minimum of five runs per prefix: 95 ms for a single message's parts subtree holding one live key, 114 ms for a session's 81 message keys, 283 ms for a session root, 573 ms for a scope's session list and 588 ms for the `sessions` root. Runtime traffic issued 19,740 traversals over the same window, about six per second, so the smallest measured cost alone accounts for more than half of the reader queue's capacity in that period. The consequence was head-of-line blocking: `GET /session/:value/message/page` averaged 12.9 s and peaked at 61.8 s while its own primitives cost about 124 ms, and `GET /global/stats` took 128 s and then 236 s.

## Decision

`scan` and `list` resolve liveness through the record primary key instead of the namespace-wide covering index. Immediate-child enumeration drives from each child node and stops at the first live descendant with a correlated existence probe, so a child with any live record beneath it is reported without collecting its subtree; `list` drives its record lookup from the recursive frontier into `(namespace, key_id)`. [Indexed storage upgrade traversal](./2026-09-16-indexed-storage-upgrade-traversal.md) owns the traversal implementation and its query-plan coverage; this record owns the measured production cost that set its target.

The frontier recursion, the parameter order and the sorted output contract are unchanged, and `body IS NOT NULL` is retained in both statements, so tombstoned records stay excluded and a child still appears only when a live record exists somewhere in its subtree. Enumerated keys are identical across the previous statement, a first revision that only replaced the liveness expression, and the shipped form, for every prefix measured on the reported store.

| prefix                          | previous | liveness expression only | shipped      |
| ------------------------------- | -------- | ------------------------ | ------------ |
| one message's parts, 1 live key | 95 ms    | under 0.1 ms             | under 0.1 ms |
| session messages, 81 keys       | 114 ms   | 3.6 ms                   | 0.7 ms       |
| session root, 8 keys            | 283 ms   | 200 ms                   | 1.9 ms       |
| scope session list, 6 keys      | 573 ms   | 453 ms                   | under 0.1 ms |
| `sessions` root, 2 keys         | 588 ms   | 459 ms                   | under 0.1 ms |

Replacing only the liveness expression left the root prefixes at 200 ms and 459 ms because the traversal still collected every node beneath the prefix and deduplicated it. Stopping at the first live descendant per child removes that remainder; `list` still returns every live record beneath the prefix, so it stays proportional to the result set by contract.

## Alternatives considered

- **Prune the recursive step instead of restructuring enumeration.** Adding a not-exists guard inside the CTE measured 446 ms to 412 ms for the `sessions` root, because the step still had to walk a subtree before it could prune it. Restructuring immediate-child enumeration so each child's probe exits at its first live descendant is what removed the remainder.
- **Batch the Rollout journal read.** `RolloutJournal.events` awaited one `Storage.read` per sequence number, and the suspicion was that this loop dominated `GET /global/stats`. Measured on the reported store, reading all 42,167 journal events across seven sessions takes 803 ms with one read per sequence number and 847-857 ms in windows of 512 through `Storage.readMany`. Per-event schema parsing dominates, the loop is strictly sequential so it never pressures the shared queue, and the batched form adds key hashing and an index map. Rejected: a measured 4% regression for no benefit.
- **Partial covering index on `storage_records(namespace, key_id) WHERE body IS NOT NULL`.** It would let the liveness probe skip the row fetch, but the `schema` array is applied on every store open, so the index is built across the full store on the next startup — worst on exactly the large homes that meet this defect.

## Consequences

A subtree traversal costs its own subtree instead of the whole record set, so the per-request read paths that call `scan` stay proportional to the data they return. The per-message parts traversal used by message paging and by the stats digest drops from 95 ms to under 0.1 ms, and root-prefix enumeration stops being proportional to the number of nodes beneath it, which removes the traversal load that was saturating the reader queue and blocking unrelated routes behind it.

The change is a read-path query rewrite: no key layout, schema, migration or API change, and it applies to both the SQLite and PostgreSQL drivers. The benchmark script reports traversal cost against a namespace holding many unrelated live records, so a regression in probe shape shows up as latency rather than as a green suite, and the companion traversal suite asserts the plan shape directly.
