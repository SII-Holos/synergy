# Decision Record: Probe traversal liveness by record key instead of scanning the namespace

Status: implemented

## Problem

A long-running workspace became unusable: switching sessions or sending a message froze the interface for tens of seconds, and the frontend's 5 s session-switch watchdog expired on 63 of 74 attempts. The dev log and the indexed observability store for the failing window recorded 606,429 storage operations in about 55 minutes, with `storage.operation.duration` tails of 17.2 s (`read`), 11.1 s (`scan`) and 9.4 s (`readMany`), while `process.event_loop.lag` stayed under 23 ms and CPU stayed under one core. The delay was queue wait on the single serialized storage reader queue, not blocked JavaScript. Reported as issue #1403.

[Agent storage](../../../architecture/agent-storage.md) owns the read path. `TransactionalStore.scan` and `list` joined the recursive key traversal against `storage_records` with `record.key_id = tree.key_id AND record.namespace = ? WHERE record.body IS NOT NULL`. SQLite planned that terminal join as `SEARCH storage_records USING INDEX storage_records_kind (namespace=?)`, so every call read the namespace-wide covering index — 89,445 live records in the reported store — regardless of subtree size. The frontier-driven recursion into `(namespace, parent_id)` is correct and already documented; the liveness filter was never covered by it.

Measured on that store with the old statement, minimum of five runs per prefix: 94 ms for a single message's parts subtree holding one live key, 114 ms for a session's 81 message keys, 286 ms for a session root, and 578 ms for a scope's session list. Runtime traffic issued 19,740 traversals over the same window, about six per second, so the smallest measured cost alone accounts for more than half of the reader queue's capacity in that period. The consequence was head-of-line blocking: `GET /session/:value/message/page` averaged 12.9 s and peaked at 61.8 s while its own primitives cost about 124 ms, and `GET /global/stats` took 128 s and then 236 s.

## Decision

`scan` and `list` express liveness as a probe of the record primary key. `scan` filters the traversed nodes with `EXISTS (SELECT 1 FROM storage_records record WHERE record.namespace = ? AND record.key_id = tree.key_id AND record.body IS NOT NULL)`. `list` selects from `storage_records` with `record.key_id IN (SELECT key_id FROM tree)`. Both statements now plan as `SEARCH ... USING INDEX sqlite_autoindex_storage_records_1 (namespace=? AND key_id=?)`.

The recursive CTE text, the parameter order, the `DISTINCT` for `scan` and the sorted output contract are unchanged, and the enumerated result sets are identical for every prefix measured. `body IS NOT NULL` is retained in both statements, so tombstoned records stay excluded and a child still appears only when a live record exists somewhere in its subtree.

Measured on the same store, minimum of five runs: a single message's parts subtree 94 ms to under 0.1 ms, a session's message subtree 114 ms to 3.7 ms, key listing 114 ms to 3.6 ms. Session-root and scope-root traversals remain 190 ms and 455 ms because they legitimately walk every node beneath the prefix; only the per-record liveness probe was mis-planned.

## Alternatives considered

- **Batch the Rollout journal read.** `RolloutJournal.events` awaited one `Storage.read` per sequence number, and the suspicion was that this loop dominated `GET /global/stats`. Measured on the reported store, reading all 42,167 journal events across seven sessions takes 803 ms with one read per sequence number and 847-857 ms in windows of 512 through `Storage.readMany`. Per-event schema parsing dominates, the loop is strictly sequential so it never pressures the shared queue, and the batched form adds key hashing and an index map. Rejected: a measured 4% regression for no benefit.
- **Partial covering index on `storage_records(namespace, key_id) WHERE body IS NOT NULL`.** It would let the liveness probe skip the row fetch, but the `schema` array is applied on every store open, so the index is built across the full store on the next startup — worst on exactly the large homes that meet this defect.
- **Early-stop pruning in the recursive step.** Skipping descent below a node that already has a live record measures 446 ms to 412 ms for the `sessions` root, because a journal subtree must still be walked to prove its children live. The extra predicate does not pay for itself.
- **A query-plan assertion in the correctness suite.** Asserting that `storage_records` is never scanned would guard the plan shape directly, but the testing standard forbids source-text assertions and private call counts in correctness suites, and no plan assertion exists in the repository. The storage benchmark reports the cost instead.

## Consequences

A subtree traversal costs its own subtree instead of the whole record set, so the per-request read paths that call `scan` stay proportional to the data they return. The per-message parts traversal used by message paging and by the stats digest drops from 94 ms to under 0.1 ms, which removes the traversal load that was saturating the reader queue and blocking unrelated routes behind it.

The change is a read-path query rewrite: no key layout, schema, migration or API change, and it applies to both the SQLite and PostgreSQL drivers. The benchmark script reports traversal cost against a namespace holding many unrelated live records, so a future regression in probe shape shows up as latency rather than as a green suite. Root-prefix traversals remain proportional to the number of nodes beneath them; that cost is inherent to the enumeration contract and is not addressed here.
