# Retention maintenance stalled the live writer and killed long sessions

## Executive summary

Long-running sessions and their child tasks died mid-task with `Unable to persist rollout evidence` and `StorageBusyError: Authoritative storage admission deadline exceeded`, repeatedly, over days. Both were one defect at two layers. The byte budget that gated retention was the _observability_ database's cap shared with the _authoritative_ database — 262 MB against a store that had grown to 18.6 GB — so `overBudget()` was permanently true and a destructive pass ran every 15 minutes forever without converging. Separately, maintenance acquired the low-level serialized writer but bypassed the store's admission gate, so it could hold the writer while consuming no admission slot and foreground writes timed out behind it; worst of all, the owner-enumeration query ran _before_ the budget check and cost 27 seconds on the real database, so every tick paid it even when nothing needed pruning.

The escape was a category error plus an accounting invariant that nothing enforced. One number was treated as if it meant the same thing for two stores four orders of magnitude apart, and an admission gate existed precisely to bound how long any holder could occupy the writer while the maintenance path was exempt from it. Neither had a metric: storage had no queue wait, depth, or hold series, and four separate queues shared one rejection string, so a stall could not even name which one produced it.

## Summary

Three symptoms pointed at one mechanism. Sessions failed with `Unable to persist rollout evidence`; the same runtime logged `StorageBusyError: Authoritative storage queue is full`; and Cortex child tasks were marked `error` with no deliverable. The first two strings look unrelated and are the same event.

A first pass already landed, making transient storage pressure pass through `record()` unchanged instead of being wrapped as permanent recording failure. That stopped one storage stall from permanently disqualifying a run's evidence, but it only relabelled the death: the retry path still classified `StorageBusyError` as an unknown error, and nothing had yet addressed _why_ the queue stalled.

Measuring the retention pass against the real database found the mechanism. The owner-enumeration statement took **27 seconds** over 6.4M rows, because it extracted key segments with `json_extract` per row:

```
|--SEARCH storage_records USING INDEX storage_records_kind (namespace=? AND kind=?)
`--USE TEMP B-TREE FOR GROUP BY
```

and it ran before the budget gate, so a pass paid for it whether or not the store needed pruning. The single-threaded worker serves statements inline, so those 27 seconds were 27 seconds of the writer being unavailable, sitting just under the 30-second admission deadline. The queue's budget is checked exactly once, after `await previous` and before `body()`, which is why the backlog failed together: when the holder finally released, every waiting caller already past its deadline unwound in the same millisecond. The log records roughly eighty lines across one millisecond, and the stall that crossed 30 seconds — 37 seconds observed — is the incident.

Two configuration facts made this recur rather than happen once. The byte budget came from `ObservabilityConfig.storage.maxSqliteBytes`, default 250 MB, narrowed further by `observability.maxBytes` — a value whose schema text describes it as "maximum **authoritative** storage bytes" while its actual job is capping the telemetry database that measured 262 MB. Against an 18.6 GB authoritative store that budget is exceeded roughly 74-fold, so the pass ran every tick, permanently. And its `reclaim` step executed unconditionally even when the pruning loop had done nothing, paying two `wal_checkpoint(TRUNCATE)` calls — a mode that waits for readers and holds the exclusive writer while pending — on every one of those ticks.

Retention also ran its work through `TransactionalStore.maintain()`, which called the driver directly with no admission slot. So a maintenance pass reserved the serialized writer while the queue reported itself free, and ordinary writers queued, hit their deadline, and failed. The invariant is simply that everyone holding the serial writer is admitted; maintenance was the one holder outside it, which is why no timeout value could have fixed this.

## Timeline

- Long sessions and Cortex child tasks were observed failing with `Unable to persist rollout evidence` across multiple days; one incident killed three child tasks plus a BlueprintLoop within one second.
- 11:50:49-11:51:27 (UTC): the log goes quiet for 37 seconds except for a 10-second HTTP heartbeat that returns in 5 ms throughout, which rules out a stalled event loop and places the stall in storage rather than the Control Plane.
- 11:51:27: roughly eighty log lines fire in one millisecond, five of them `Authoritative storage admission deadline exceeded`, followed by `Rollout recording has already failed` and `cortex task execution failed` for three tasks plus a BlueprintLoop.
- Statistical check on the same log: 7 of 29 storage stalls of 5 s or more land on the 15-minute retention grid within 2 s, against 0.16 expected by chance — roughly 30-fold enrichment.
- Measurement against the authoritative database: 6.4M rows, 18.6 GB, `auto_vacuum=2`, `freelist_count=0`, and the owner-enumeration query taking 27 s. Splitting it to group by the indexed `scope_id`/`session_id` columns returns the identical 119 owners in 4.9 s. An indexed rewrite plus a tiny separate `operations` branch totals 7.0 s and is reached only when a store is already over budget.

## Root cause

Two independent defects converged.

**One budget, two stores.** Retention compared the authoritative store against the observability database's byte cap. The two differ by roughly 74-fold on a mature installation, so the comparison was permanently true and the pass ran destructively forever against a target it could never reach, because the retention window and live-session protections bound how much it is allowed to delete. No tuning of that single number can fix it: any value large enough for one store is a permanent trigger for the other. This is a control-loop design failure — a permanently true trigger with a bounded-per-run effect never terminates — and it is the same class as Kafka's per-partition `retention.bytes` trap, where one number silently means different things at different scopes.

**Maintenance outside the admission invariant.** `TransactionalStore.maintain()` reserved the driver's serialized writer without acquiring the store's admission slot, so `holders(serial_writer) ⊆ admitted(work)` did not hold. Foreground writers therefore queued behind work the gate could not see, and failed on their deadline while the queue reported itself healthy. The 30-second deadline was not the bug; it was the gate reporting a violation it could not prevent.

Three amplifiers turned a slow pass into a fatal one. The owner scan ran before the budget check, so its 27 seconds were unconditional. That scan used `json_extract` per row where indexed columns already held the same values. And the reclaim step ran two blocking `TRUNCATE` checkpoints on every tick, including ticks that pruned nothing.

Why every safety net missed it. The storage write path had **no queue observability at all** — no wait, depth, or hold series — while `tool`, `agent`, and `policy` each had them, so the wait that reached the deadline and the caller causing it both left no trace. Four `StorageQueue` instances shared one rejection string, so a failure could not name its own queue. Retention logged nothing and raised no issue, its whole `Report` (including an already-computed `capped` flag) was discarded by the scheduler. Tests exercised each mechanism in isolation: retention tests used tiny fixtures where the budget was reached trivially, so nothing asked what happens when the budget is unreachable, when maintenance is slow, or whether a pass costs anything when the store is already healthy. And the first fix, the one already landed, treated the symptom that was loudest rather than the stall that produced it.

## Guardrails added

- Budget split and gating: `storage.retentionBytes` is a distinct authoritative budget, deliberately not narrowed by `observability.maxBytes`, and the budget is evaluated **before** any enumeration so a healthy store pays nothing. `packages/harness/test/observability/retention-config.test.ts`.
- Reachability guard: a store over budget with nothing the window permits removing now reports `infeasible`, raises `STORAGE_RETENTION_BUDGET_INFEASIBLE` with the measured numbers, and prunes nothing instead of looping. `packages/harness/test/storage/retention.test.ts`.
- Cadence control: a pass that ends still capped defers its next run by a doubling interval, so a misconfigured budget cannot become a permanently running deletion loop.
- Bounded live maintenance: reclaim uses `wal_checkpoint(PASSIVE)` (never waits for readers, never invokes a busy handler), WAL disk is bounded by `journal_size_limit` instead, and reclaim runs only after a pass actually removed records.
- Admission invariant: `TransactionalStore.maintain()` acquires the same admission slot as any other writer. `packages/harness/test/storage/queue-admission.test.ts`.
- Indexed owner enumeration: the `operations` set is a separate bounded query, and rollout owners group by the `scope_id`/`session_id` columns. **The grouping statement was not actually fast when this was written**, and the claim above originally read as though it were: the group still materialised a temporary b-tree and, more expensively, still selected `MIN(key_text)`, a column no index in the schema carries. Grouping "by indexed columns" only says which columns the group keys on, not that the statement's cost is bounded by owner count. Against the production-sized store this guardrail described a statement taking 164-251 s. [The follow-up fix](../decisions/implemented/bug-fix/2026-09-20-index-the-rollout-owner-columns-for-retention.md) added an index that carries the owner columns and removed the `key_text` selection, which is what made the description true.
- Observability, the gap that made this hard to diagnose: `storage.queue.wait`, `storage.queue.depth`, and `storage.queue.hold` now exist, every `StorageQueue` carries a name that appears in its rejections, and retention records per-pass counters plus the budget ratio. The `hold` series is the one that names the caller holding the writer, which was previously invisible by construction because the budget is checked only before the body runs.
- Documentation: [agent storage](../../docs/architecture/agent-storage.md) states the budget separation, the reachability guard, the passive checkpoint, and the admission invariant; the [capacity decision](../../docs/decisions/implemented/architecture/2026-09-18-storage-retention-and-incremental-vacuum.md) records what shipped and why the alternatives lost.

## Lessons

A budget that can never be reached must be reported, not acted on. Any recurring job whose precondition is a threshold needs an explicit reachability check and a backoff, because a permanently true trigger plus a bounded effect is an infinite loop that looks like diligence in the logs.

Admission accounting has to be structural, not conventional. One holder outside the invariant is enough to break it for everyone, and a caller-facing timeout will never repair it — the timeout is the gate reporting that its model of the world is wrong.

The metrics you do not have decide how long an incident lasts. Storage had no queue series and four queues sharing one error string; adding wait, depth, hold, and an identity turned an unattributable stall into a named operation and a named holder.

Measure the real artifact. The owner scan looked bounded in the source, ran instantly on test fixtures, and took 27 seconds against the production-sized database. Test-scale performance is not evidence about the path that recurs for days.
