# Decision Record: Keep transient storage pressure out of the recording-failure path

Status: implemented

## Problem

Long-running sessions and their child tasks died mid-task with `Unable to persist rollout evidence`, and the same runtime produced `StorageBusyError: Authoritative storage queue is full`. The two strings look unrelated; they are one defect.

`StorageQueue.run` throws a plain `StorageBusyError` when its wait budget expires or its depth cap is reached — a rejection the caller can retry once the queue drains. It carries no `RolloutRecordingError` name. But two catch-alls wrapped it into one:

- [record()](../../../../packages/harness/src/session/rollout/error.ts) wrapped _every_ non-recording error as `RolloutRecordingError("Unable to persist rollout evidence")`, discarding the transient/permanent distinction.
- [worker-pool](../../../../packages/harness/src/session/agent-turn/worker-pool.ts) wrapped every non-recording archive-drain error as `RolloutRecordingError("Unable to persist worker rollout evidence")`.

The recording-error class is the terminal signal for the whole rollout contract. `RolloutCall` and `RolloutOperation` respond to it by calling `SessionManager.signalAbort` and `RolloutLedger.failRecording`; `failRecording` persists `recording: "failed"` and latches admission closed; `requireRunning` then refuses every later call with `Rollout recording has already failed`, `reopenRun` refuses the run, and `finishRun` refuses completion. Retry was suppressed at four further layers — `processor`'s `fastAbort`, `SessionRetry.retryable`, `providerRetryable`, and cause erasure in `NamedError.toObject()`.

A production incident shows the blast radius: one storage stall produced roughly eighty log lines in a single millisecond, killing three Cortex child tasks plus a BlueprintLoop. The burst is itself a symptom of the queue's shape — the deadline is evaluated once, after `await previous` and before `body()`, so the whole waiting backlog fails together at the moment the queue drains. Every caller already past its budget shared one outcome.

The repository already treated these two classes as transient elsewhere: [rollout lifecycle](../../../../packages/harness/src/session/rollout/lifecycle.ts) and [session input](../../../../packages/harness/src/session/input.ts) both enumerate `StorageBusyError`/`StorageClosedError` and pass them through unchanged. The queue path simply never reached those guards.

## Decision

Transient storage pressure now reaches the caller as itself, so recovery keys stay meaningful.

[record()](../../../../packages/harness/src/session/rollout/error.ts) gains `isTransientStorageError`, a cause-chain walk that recognizes `StorageBusyError` and `StorageClosedError`, and rethrows the original error instead of wrapping it. The existing cause walk was extracted into a shared `causes` generator so `findRecordingError` and the new predicate traverse `cause`/`error`/`suppressed`/`lastError` plus `errors[]` under the same 64-node bound. Genuine evidence corruption — a failed marker write, an unreadable pending set, a changed execution identity — still wraps and still terminalizes, and a nested `RolloutRecordingError` still wins over the transient check so an already-failed recording is never downgraded.

[worker-pool](../../../../packages/harness/src/session/agent-turn/worker-pool.ts) applies the same predicate at its archive-drain catch, so the session-owner turn path stops converting storage pressure into a poisoned archive-ack. The failure is still delivered to the worker and the stream; only its class changes.

[SessionRetry.retryable](../../../../packages/harness/src/session/retry.ts) admits the condition the same way it already admits an agent-worker exit: the persisted error is an `UnknownError` whose message carries the original name, so a prefix match returns a full ten-attempt decision under the existing transport budget. `MessageV2.fromError` still stores it as `UnknownError`; no new persisted error variant, schema field, or route change is introduced.

[StorageQueue](../../../../packages/harness/src/storage/queue.ts) measures its wait budget on the monotonic clock. A suspended host advances the wall clock without letting the queue make progress, so a suspend could spend a caller's budget it never used. This mirrors the [SQLite worker deadline](../../../../packages/harness/src/storage/sqlite-driver.ts) already moved to `performance.now()` by [Measure the SQLite request deadline on a monotonic clock](2026-09-19-sqlite-worker-suspend-resilience.md); `setTimeout` still does any scheduling, and only the decision is monotonic.

Behavioral coverage lives in `packages/harness/test/session/rollout-transient-storage.test.ts` (a rejected artifact write leaves the run's recording intact and the turn retryable), in the retry suite (storage pressure is admitted with the full attempt budget), and in the worker-pool suite (the archive-ack and the failed stream carry `StorageBusyError`, not a recording error).

## Alternatives considered

**Widen `findRecordingError` to stop at every known error class.** It would invert the predicate: the walk exists to find one specific terminal class, and enumerating pass-through classes inside it would make each new error type a silent correctness decision in the traffic-controller helper.

**Give `StorageBusyError` its own persisted `MessageV2` variant so retry classification is structural.** Cleaner in principle, but it changes a persisted schema, the worker error frame, and the generated SDK for what the existing agent-worker-exit precedent already handles by message — too much blast radius for an emergency fix whose value is that sessions survive.

**Retry inside `StorageQueue` instead of surfacing the rejection.** Re-queueing would add a nested retry loop below callers that already own retry policy, and it would hide sustained saturation — the condition operators most need to see.

**Leave the queue on wall-clock time.** The clock change is separable, but it is the same false-positive class already fixed one layer down and already documented; leaving it would let a host suspend reject requests whose budget it never spent.

**Fix only the `record()` wrap.** Necessary but not sufficient, and the second wrap site proves it: the worker-pool path is the one a long session actually takes, and a caught-but-unadmitted rejection would still terminalize the turn.

## Consequences

A storage stall now costs a bounded retry instead of the session and its child tasks. `Unable to persist rollout evidence` continues to mean what the durable contract says it means: evidence that could not be written and will not be, never a merely busy store.

What this does not fix is what stalls the queue. The transition to `recording: "failed"` is now harder to reach, so the failure surfaces as retry latency rather than a dead run — and a genuinely wedged store still fails, just later and without poisoning evidence. The trigger remains owned elsewhere: retention runs on a 15-minute sweep whose byte budget defaults far below a mature authoritative database, and `TransactionalStore.maintain` acquires the driver write queue without the store's admission gate, so a maintenance pass can hold the serial writer while consuming no admission slot. Both are worth their own change.

Retry classification by message prefix is the fragile edge: it depends on `Error.toString()` producing `StorageBusyError` at the head of the persisted message. A future rename or a different wrapper shape would silently drop the turn back to terminal, which is why the transient pass-through in `record()` — not the prefix match — is the load-bearing part of this change.
