# Decision Record: Fence queued follow-ups on Cortex cancellation

Status: implemented

## Problem

Cancelling a Cortex task could silently restart the cancelled work. A parent could queue a corrective `session_send` follow-up into a running child session, cancel the task minutes later, and receive an unqualified "cancelled" acknowledgement — after which the child's queued mail was materialized as a new root user message and the child kept editing the workspace the parent had begun to reclaim. The durable Cortex status stayed `cancelled` while an untracked session loop ran, so the frontend also showed no active work. The runtime timeout path had the same hole: a task that exceeded its runtime limit still released its lease with a pending-work request, waking the queued follow-up. Reported in [#1339](https://github.com/SII-Holos/synergy/issues/1339) against `62c546c60`; the session/cortex refactor (#1353) moved the code but did not close the gap.

## Decision

Cancellation that Cortex owns is now fenced end to end.

`SessionManager.signalAbort` accepts `fenceQueuedWork` together with a `fenceQueuedBefore` timestamp, recorded on the loop owner and exposed through `SessionManager.fenceQueuedBefore`; `SessionInvoke.cancel` forwards the option.

`Cortex.cancel` and the runtime-timeout path signal the abort with `fenceQueuedWork: true`, then discard the child session's queued inbox items through `SessionInbox.fenceQueuedWork` before the terminal status is persisted, so the returned acknowledgement already means every follow-up queued before the fence is gone. Mail delivered after the cancelled acknowledgement is newer than the fence and survives as explicit new work. A cleanup failure propagates: the cancel rolls back its cancellation request and throws instead of acknowledging, and `task_cancel` reports the cancellation as incomplete so the parent does not take over the workspace.

Inbox writes and cancellation purges share a per-session lock. The fence is strictly greater than every existing item timestamp, including mail created in the same millisecond; subsequent writes inherit the active fence as their minimum timestamp. Notifications run after releasing the lock. This makes an already-started storage write part of the purge without discarding explicit new work. Bulk cancellation attempts every child and reports an aggregate error when any child fails, rather than claiming all children were cancelled.

The loop's abort boundary extends its existing steer/context disposal to task items queued before the fence timestamp when the active abort is fenced; unfenced user aborts keep task items exactly as before.

A fenced run's release requests follow-up work only when runnable items newer than the fence exist, closing the release-drive wake path for pre-fence items for every internal caller of `SessionManager.run`, not just Cortex.

`task_cancel` no longer returns an unqualified "cancelled": the output states that queued follow-ups were discarded, in-flight execution is stopping, and the parent should wait for the session to go idle before taking over the workspace — on both the single-task and the cancel-all paths — and reports an incomplete cancellation loudly when cleanup failed.

At the runtime deadline the timeout claims the task before its first await (`timeoutRequests`/`timeoutErrors`), so a run settling concurrently cannot publish completed first: every settlement path converts the claim into the runtime-limit error, and a cleanup failure is folded into that error message instead of being swallowed.

## Alternatives considered

**Bind each queued item to a task/execution generation and reject stale items at consumption time.** This is the issue's most general suggestion and would survive any future source that queues work against a child session, but it requires touching every enqueue path plus the item schema and persisted-state migration for a failure mode that today has exactly one writer with an existing disposal protocol (`signalAbort`'s comment already promises internal cancellations remove their own inbox items). Fencing reuses that protocol, and the fence timestamp keeps delivery-versus-cancel races well-defined without per-item schema changes; generation binding can layer on later if a second internal writer appears.

**Await task-run settlement inside `Cortex.cancel` before acknowledging.** This matches the issue's "cancelling vs stopped" wording, but Cortex deliberately documents cancellation as non-blocking (`cancel-nonblocking.test.ts`), and an in-flight LLM turn can take minutes; making `task_cancel` wait would stall the parent's loop. The fence achieves the safety property (no restart, no writes after takeover begins) without changing the acknowledgement's latency contract.

**Purge the child inbox from the loop side only (no `Cortex.cancel` drain).** The abort-boundary drain already covers the loop-exit path, but relying on it alone leaves a window where the durable cancellation is visible while queued items are still consumable by other drivers (startup inbox recovery, explicit wake). Draining synchronously in `cancel()` closes the acknowledgement-to-state gap the issue demonstrated.

## Consequences

A cancelled or timed-out task can no longer be resurrected by mail queued before cancellation, and the parent hears an honest acknowledgement. Explicit new work sent after cancellation still starts and is driven normally, so session reuse is unaffected.

A fenced run keeps its release-time follow-up drive only for items newer than the fence; pre-fence items lose it by design, and user aborts (`recoverQueuedTasks`) keep their existing behavior. Queued follow-ups sent before the cancellation are deleted, not quarantined; a caller that needs delivery after cancellation resends, which matches how a parent would re-task an idle session anyway.
