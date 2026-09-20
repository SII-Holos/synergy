# A healthy SQLite worker was declared dead and killed the runtime

## Executive summary

A `bun dev desktop --managed` backend self-terminated at 18:15:56 local after roughly eight and a half hours of uptime, and the desktop client lost its connection with no error of its own. The driver had probed the SQLite worker three times, got no answer, concluded the worker was permanently unrecoverable, latched the authoritative store, and the runtime then shut itself down deliberately so a supervisor would restart it.

The worker was never dead. It was occupied. One retention statement — an owner-enumeration `GROUP BY` over 15,081,375 rollout rows that had lost its supporting index two commits earlier — took 182 seconds against the live store, and the worker serves statements inline on a single event loop. A probe is answered from that same loop, so a worker running one long statement cannot answer a probe no matter how healthy it is. The driver had no way to tell "busy" from "dead", so it chose dead, and the chosen response to a slow statement was to kill the whole process.

Two things made the outcome inevitable rather than improbable. The probe budget and the request deadline were the same 30 seconds, so any statement over 120 seconds was fatal by construction — while the _maintenance_ deadline for the same class of statement was computed as `600_000 + ceil(bytes / 1024²) × 1000`, which at 42.9 GiB is 12.16 hours. The code simultaneously believed a statement might legitimately run for twelve hours and killed the process after two minutes. Separately, the store was 42.9 GiB against a 40 GiB retention budget, so the pass that ran that statement was reached on every 15-minute tick, permanently.

The escape is a closed loop with no observability inside it. Nothing measured the probe path, so the reason a probe failed was discarded at the exact point it was known; the one thing that could have named the cause left no trace. And every existing test asserted each half in isolation — a probe that always answers, a worker that never answers, a statement that outlives its deadline — with no case for the only shape that mattered: a worker that is slow _and_ alive.

## Summary

The failure was one mechanism with two layers, and both were needed.

An ordinary request carries a 30-second deadline. When it expires the driver does not immediately fail it: it probes the worker to decide whether the request was slow or the worker is gone. It sends up to three `ping` requests, each with its own 30-second budget. If all three go unanswered it calls `failTerminal`, which latches an `unavailableError`, kills the worker, rejects every pending request with that same error object, and notifies `Storage.onUnavailable`. The runtime subscribes to that hook and calls `gracefulShutdown("storage-unavailable", 1)`.

So the effective terminal budget was `30_000 + 3 × 30_000 = 120_000` ms. That number appears nowhere in the code; it is the composition of two constants and a retry count. Its own comment stated the limitation plainly — "a healthy worker running a long statement is therefore indistinguishable from a hung one until the statement finishes" — and the mitigation offered was retrying a bounded number of times. Retrying a probe that is answered from the occupied event loop cannot succeed. The mechanism could only ever report "occupied" and had no branch for it except death.

The statement that occupied the loop was `TransactionalStore.evidenceOwners()`, reached from retention's 15-minute sweep. It groups rollout records by `scope_id` and `session_id` and, in the version running at the time, also selected `MIN(key_text)`. `key_text` is carried by no index, so every one of 15,081,375 rows required a table walk. Measured against the live store after the fact, that form takes **182 seconds**; the current form, which selects only indexed columns, takes **1.36 seconds**.

The reason the store reached that size is the second layer. `retentionMs` defaulted to 7 days and `retentionBytes` to 40 GiB. Measured ingress is roughly 5.2M rows and 9 GB per day, so a 7-day window needs about 63 GB — 1.6 times the budget. The retention window and the byte budget were each internally reasonable and jointly unsatisfiable. Every sweep therefore found `overBudget` true, enumerated owners to discover nothing was old enough to prune, and reported `infeasible`. That is a control loop whose trigger is permanently true and whose per-run effect is bounded by its own protections, which means it never terminates and never converges.

At 03:43:13 the same mechanism produced a non-fatal rehearsal. `Authoritative storage admission deadline exceeded (store.writes)` and the same for `artifact.gate` fired together, and one `/event/replay` request completed in **49,297 ms**. The worker recovered on that occasion because whatever held the loop finished before the probe budget ran out. It did not at 18:15:56.

## Timeline

All times local (UTC+08:00).

- 09:41:46 — the backend starts from a build made at 08:22:41. Its schema migrations run `20260920-storage-drop-scope-index`. The replacement index, `20260920-storage-records-owner-index`, was committed at 13:16:49 and is not in this build.
- 11:43:13 — the first symptom. `Authoritative storage admission deadline exceeded (store.writes)` and `... (artifact.gate)` fire together, and a `/event/replay` request takes 49,297 ms. The worker answers, so nothing terminal happens. Across the run this admission failure appears five times.
- 18:13:56 — 182 seconds before the terminal event. `evidenceOwners()` begins on the retention sweep and takes the worker's event loop.
- 18:15:56 — an unrelated request's 30-second deadline expires, three probes over 90 seconds all go unanswered, `failTerminal` latches, and `service=server-runtime signal=storage-unavailable shutting down` is logged one millisecond later.
- 18:15:59 and 18:16:03 — `service=session.manager` retries a session wake with `error=The SQLite worker did not answer a liveness probe and cannot be recovered`, with exponential backoff. These are consequences, not causes.
- 18:16:06 — `service=server-runtime signal=storage-unavailable runtime cleanup timed out`, and the log ends. The runtime watchdog had fired after the shutdown budget expired; the drain was unbounded because `StorageQueue.close()` awaited its tail with no timeout and `SqliteDriver.close()` awaited `worker.exited` with no timeout.
- 18:40:06 — the runtime is restarted manually. The new build runs `20260920-storage-records-owner-index`, which takes 140,191 ms to build. The same enumeration then completes in about 1.4 seconds, and the store stays healthy.

## Root cause

**A liveness signal that shares the resource it is measuring.** The probe is dispatched to the worker and answered from the worker's own event loop. That loop also runs every statement, one at a time. So "the probe did not answer" is exactly equivalent to "the loop has not returned to the top of its queue", which is true both for a hung worker and for a healthy one mid-statement. The signal cannot separate the two cases, and the code treated one of them as the other. The comparison is worth stating plainly: Linux's hard-lockup detector uses an out-of-band (NMI) check precisely because an in-band timer cannot run on a CPU that has stopped responding — this probe is the in-band timer.

**A policy that answered "busy" with "kill".** Once the probe had failed, the only available transition was `failTerminal`. There was no degraded state, no backpressure, no retry-the-caller path. Cloudflare Durable Objects — the closest published analogue, a single-threaded store — accept indefinite blocking of the single thread and instead gate the observable boundary; Google's SRE book states that an overloaded backend should keep serving at a sustainable rate rather than stop accepting all traffic. Here a slow statement took down the process.

**Two budgets that contradicted each other.** The ordinary and probe deadlines composed to a 120-second terminal budget, while the maintenance deadline was computed from the database size and reached 12.16 hours at 42.9 GiB. Both numbers were live in the same file. The maintenance figure reflected a real requirement — rebuilding an index over a large table genuinely takes minutes — but expressing it as "one statement may take hours" is incompatible with a worker that answers probes from the same loop. The size-scaled formula also hid the contradiction: the bigger the store grew, the more licence one statement had to occupy the loop, and the more certain the fatal path became.

**A retention policy that could not be satisfied.** A 7-day window at 9 GB/day needs about 63 GB against a 40 GiB budget. `infeasible` was already recognized and reported as a configuration problem, which is honest, but it did not stop the sweep from being scheduled permanently, and it left the destructive statement on the hot path of a store that was always over budget.

**Why every safety net missed it.** Nothing measured the probe path. The `StorageBusyError` constructed when a probe timed out was passed to `settle`, whose probe branch was `reject: () => resolve(false)` — the error was built and then discarded, so the reason for the failure existed for one expression and reached no caller, no metric, and no log. `storage.queue.hold` and `storage.operation.duration` did exist and did record the stall, but nothing connected "one statement held the writer" to "the probe will fail in 120 seconds". The tests covered each half separately: `storage-worker-suspend.test.ts` asserted a worker that always answers is not killed and a worker that never answers escalates; nothing asserted what happens to a worker that is slow and alive for longer than the probe budget, which is the only case that occurred.

## Guardrails added

- Probe timeouts no longer latch. `SqliteDriver` carries an explicit worker state (`healthy | busy | exited | latched`); an unanswered probe records the silence and marks the worker busy, and only silence sustained past a configurable ceiling reaches `failTerminal`. An unexpected `worker.exited` still latches exactly as before. `packages/harness/test/storage/storage-worker-suspend.test.ts`.
- A busy worker fails new work fast with a retryable `StorageBusyError` instead of queueing behind the statement that is already over budget, so a caller gets a signal it can act on rather than a long wait ending in death. The existing retry path in `session/retry.ts` already treats `StorageBusyError` as transient.
- The probe failure is now observable. It records `storage.worker.probe.timeout` and, on entering the degraded state, `storage.worker.busy` with a `STORAGE_WORKER_BUSY` issue naming the ceiling; recovery records `storage.worker.recovered` and clears the state. The discarded-error path is gone.
- Maintenance statements share one fixed chunk budget, and everything that could exceed it is chunked. The size-scaled deadline is removed. `retention`'s `pruneTree` now deletes in bounded batches (`PRUNE_CHUNK = 4096`) instead of issuing one `DELETE` whose cost grew with the subtree. `packages/harness/test/storage/budgets.test.ts` asserts the invariant that the chunk budget times its margin never reaches the ceiling, including for a configuration that tries to raise it above.
- Teardown is bounded. `StorageQueue.close()` and `SqliteDriver.close()` are wrapped in a timeout, so a drain that cannot finish escalates by killing the worker instead of letting the runtime watchdog exit before `RolloutRecovery.settle()` runs.
- The retention window is derived from the budget and the measured ingress rate, so a store can no longer claim to retain more than it can hold, and `infeasible` no longer describes a permanent no-op.
- The record body format compresses on an honest size comparison. The retired codec required 512 bytes, compared a base64 expansion against the original, and therefore had to beat an inflated target; on the live store 91% of rollout bytes were stored uncompressed. Measured against real bodies, the sizes actually reachable are 43.3% smaller for the bodies that were stored plainly and above the floor.

## Lessons

**A liveness signal must not share the resource it measures.** If answering "are you alive" requires the same single-threaded resource as doing the work, the signal can only report occupancy. Either measure from outside the occupied resource or accept that the only available verdict is "unresponsive", which is a different question from "dead" and needs a different response.

**A timeout is a policy choice, not a measurement.** `120_000` was never written down; it was assembled from a deadline, a retry count, and a probe budget, and its consequence — one slow statement kills the process — was nobody's decision. Derived limits should be stated as limits, and the invariants relating them should be asserted, including across classes of statement that intend to be slow.

**Two limits that must both hold need a stated relationship.** A window and a budget that cannot both be satisfied produce a control loop that runs forever without converging. `infeasible` named the condition correctly but did not remove the loop; a derived window does.

**An error discarded at the point of knowledge is invisible forever.** The probe's `StorageBusyError` was constructed and thrown away one expression later. Had it been recorded, the very first occurrence would have shown a probe timing out while the worker was merely occupied, and the mechanism would have been obvious without an incident.

**Test the conjunction, not only the halves.** Every component here had a passing test. The failure lived in the interaction — slow _and_ alive, over budget _and_ protected — which no test asserted.

**A signal that cannot fail its own failure mode is not a safety net.** `probeAttempts = 3` read as retry discipline. Because each probe was answered from the same occupied loop, three attempts measured one fact three times. More attempts, or a longer probe budget, would have changed only how long the process took to kill itself.
