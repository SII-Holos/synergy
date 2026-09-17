# Decision Record: Probe traversal liveness by key and read rollout journals in batches

Status: implemented

## Problem

A long-running workspace became unusable: switching sessions or sending a message froze the interface for tens of seconds, and the frontend's 5 s session-switch watchdog expired on 63 of 74 attempts. The dev log and the indexed observability store for the failing window recorded 606,429 storage operations in about 55 minutes and `storage.operation.duration` tails of 17.2 s (`read`), 11.1 s (`scan`) and 9.4 s (`readMany`), while `process.event_loop.lag` stayed under 23 ms and CPU stayed under one core. The delay was queue wait on the single serialized storage reader queue, not blocked JavaScript. Reported as issue #1403.

Two independent cost defects produced that pressure; [agent storage](../../../architecture/agent-storage.md) owns both read paths.

`TransactionalStore.scan` and `list` joined the recursive key traversal against `storage_records` with `record.key_id = tree.key_id AND record.namespace = ? WHERE record.body IS NOT NULL`. SQLite planned that terminal join as `SEARCH storage_records USING INDEX storage_records_kind (namespace=?)`, so every call read the namespace-wide covering index — 89,460 live records in the reported store — regardless of subtree size. The frontier-driven recursion into `(namespace, parent_id)` is correct and already documented; the liveness filter was never covered by it. Measured on that store: 89 ms for a one-record subtree, 108 ms for a session's message subtree, 583 ms for the `sessions` root. Runtime traffic issued about six scans per second, so the reader queue was busy more than half the time, `GET /session/:value/message/page` averaged 12.9 s, and its own primitives cost about 124 ms.

`RolloutJournal.events` read one key per sequence number, and each read is a `BEGIN`/`SELECT`/`COMMIT` round trip to the separate SQLite worker process. `RolloutSnapshot.read` consumes that generator, `Aggregator.digest` calls it once per session, and `Engine.get()`, which serves `GET /global/stats`, calls `Aggregator.digestAll`. The workspace held 52,167 journal events across seven sessions, 19,412 of them in the largest. The same synthetic namespace measured the per-key loop at 0.074 ms per event uncontended (5,000 events in 368 ms), so that workspace carried roughly 3.8 s of service time and about 156,000 IPC round trips from this loop alone; the observed 128 s and 236 s stats refreshes identify the remainder as reader-queue wait behind the traversal load above.

## Decision

`scan` and `list` express liveness as a probe of the record primary key. `scan` filters the traversed nodes with `EXISTS (SELECT 1 FROM storage_records record WHERE record.namespace = ? AND record.key_id = tree.key_id AND record.body IS NOT NULL)`. `list` selects from `storage_records` with `record.key_id IN (SELECT key_id FROM tree)`. Both plans become `SEARCH ... USING INDEX sqlite_autoindex_storage_records_1 (namespace=? AND key_id=?)`. The recursive CTE text, the parameter order, the `DISTINCT` for `scan` and the sorted output contract are unchanged, and the enumerated result sets are identical.

`RolloutJournal.events` reads the requested revision range in windows of 512 sequence numbers, one `Storage.readMany` per window, and yields the parsed events in ascending order. Boundary validation, ascending order, the `Rollout journal sequence mismatch` check and empty-range behavior are unchanged. A sequence number absent from a batch falls back to the original single-key `Storage.read`, so a genuinely missing committed event still raises the typed miss and its storage observability issue. Recovery keeps its own transactional single-key loop.

Measured on the reported store: message-subtree `scan` 108 ms to 3.8 ms and `list` 111 ms to 3.6 ms. Measured by the storage benchmark on a synthetic namespace of 20,001 live records: `scan` 6.0 ms to 0.9 ms, `list` 3.9 ms to 0.2 ms, and a 5,000-event journal read 368 ms to 69 ms with the round trips falling from about 25,000 to about 60. A 19,412-event journal drops from about 58,000 single-key reads to 38 batched reads.

## Alternatives considered

- **Partial covering index on `storage_records(namespace, key_id) WHERE body IS NOT NULL`.** It would let the liveness probe skip the row fetch, but the `schema` array is applied on every store open, so the index is built across the full store on the next startup — worst on exactly the large homes that meet this defect, and a startup-blocking cost the traversal change does not need.
- **Early-stop pruning in the recursive step.** Skipping descent below a node that already has a live record measures 446 ms to 412 ms for the `sessions` root, because a journal subtree must still be walked to prove its children live. The extra predicate does not pay for itself.
- **A query-plan assertion in the correctness suite.** Asserting that `storage_records` is never scanned would guard the plan shape directly, but the testing standard forbids source-text assertions and private call counts in correctness suites, and no plan assertion exists in the repository. The storage benchmark reports the cost instead.
- **One `Storage.readMany` over the whole journal range.** Fewest round trips, but it materializes every event of a revision before the first yield. Bounded windows hold the peak at one window of parsed events.
- **Throwing directly for a missing batched event instead of re-reading it.** `readMany` reports an absent key as `undefined` and records no storage issue, so the fallback is what preserves the existing typed error and observability for that corruption case.
- **Tuning digest concurrency or yielding between sessions.** That masks the cost instead of removing it: a single session's digest was itself the multi-minute operation.

## Consequences

A small-subtree traversal costs its own subtree instead of the whole record set, so the per-request read paths that call `scan` — message parts, message infos, history events, navigation, agenda and note stores — stay proportional to the data they return. Digesting a long Rollout revision costs one batched read per 512 events, which returns `GET /global/stats` to the seconds range and lets the shared reader queue drain, so the head-of-line blocking that stalled unrelated routes disappears.

Both changes are read-path only: no key layout, schema, migration or API change, and existing homes need no upgrade. The benchmark script reports traversal and journal-read cost against a namespace with many unrelated live records, so a future regression in probe shape shows up as latency rather than as a green suite. The residual cost of a batched journal read is per-event schema parsing, which does not change with the batching. The remaining known cost is write amplification in Rollout artifact recording, where a chunk flush performs a durable file write plus a `FULL`-synchronous transaction; that is a volume and disk-lifetime concern rather than the queue-blocking one fixed here.
