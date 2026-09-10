# Decision Record: Release the session lease before detached turn settlement

Status: implemented

## Problem

Every finished turn stalled before going idle. After the assistant message finished streaming, the sidebar kept showing the session as running and queued inbox messages were not driven until the loop's finalization completed. The finalization awaited the entire turn-end barrier: `LoopJob.drain()` waited for every background job, including the `summarize` job whose file-diff, title, and body work performs two LLM calls (60s per-call / 120s per-run / 180s per-job ceilings), and the rollout `finishSegment` + `reconcile` settlement chain re-read the full model history multiple times after the loop-scoped message cache was already dropped. Introduced with the rollout evidence ledger (#1341), the barrier turned background evidence work into critical-path latency: session idle — the only signal that stops the sidebar's running state and the gate for release-driven inbox arbitration — published only after all of it settled. Removing the drain alone was not enough: `release()` aborts the lease controller, every background job's signal derives from that lease (directly or through the rollout causal context joined into `AgentCall`), so detached work would have been killed the moment the lease released.

## Decision

Background jobs can now declare `detached: true` to outlive the turn. Detached runs ignore the loop lease abort entirely — `executeWithTimeout` builds their signal from the job timeout plus an explicit per-session cancel controller, and detached execution strips the lease signal from the rollout causal context so nested `AgentCall` work does not inherit it either. `LoopJob.drain()` excludes detached runs; a new `LoopJob.settleDetached()` waits for them and surfaces their `RolloutRecordingError`s, and `LoopJob.cancelDetached()` aborts them and drops pending payloads. `summarize`, `ensure-title`, and `chronicle` declare `detached: true`; `chronicle` no longer embeds the lease signal in its payload and forwards only its own signal.

The loop finalization in `SessionInvoke` now finishes segments immediately and fires release without waiting for detached work, so `session.idle` publishes as soon as the turn's model work ends. Rollout run reconciliation moves behind that settlement: `settleDetached()` first (so detached ledger records land), then `reconcile()` per processed run. Settlement failures are logged instead of thrown — the loop result is already committed, a later reconcile settles runs left behind, and the ledger finishers are idempotent. Explicit cancellation closes the gap deliberately: `RolloutLifecycle.cancel()` calls `cancelDetached()` then `settleDetached()` before `finishRun`, and runtime shutdown cancels detached runs before `drainAll()`. Recording failures inside bound jobs keep aborting the owning loop; detached recording failures surface through `settleDetached()` without poisoning later loops for the same root.

## Alternatives considered

**Move only the drain and keep summarize bound to the lease.** Not taken: `release()` aborts the lease controller, so the moment idle published, the summary's LLM calls died through the shared signal. The summary queue would have marked diffs as errored, and title/body generation would never complete — trading a latency regression for a data regression.

**Keep reconcile synchronous but drop only the drain.** Not taken: profiling the barrier showed the drain was the dominant cost, but reconcile still re-read the full model history after the loop-scoped cache was dropped, so long sessions kept paying a second stall after every turn. Settlement-after-release removes both.

**Fire-and-forget reconcile without settleDetached.** Not taken: reconciling a run while its detached summary work is still writing call records would let `settleOrphanedRecords` mark in-flight records as interrupted and `finishRun` would close the run with incomplete evidence. The settlement gate keeps the evidence ledger trustworthy without making it a latency gate.

**Downgrade summarize to best-effort with no settlement.** Not taken: summary state is user-visible UI data written through `Session.updateMessage`/`Session.update`, and its recording failures feed the rollout ledger. Dropping the settlement surface would hide failures entirely instead of routing them to the one caller that still owns waiting.

**Delete interrupted-turn summaries when the session wakes next.** Not taken: summaries are derived, append-safe state; a wake-time sweep adds a second settlement path with its own races against the FIFO queue. The settlement-before-reconcile ordering plus a later-turn reconcile already converges the run state.

## Consequences

Session idle publishes as soon as the model work ends, so the sidebar stops spinning and queued inbox messages drive immediately after a turn; the summarize/title/chronicle LLM latency moves fully off the critical path. Rollout evidence keeps its closure guarantee: detached work settles before `finishRun`, and explicit cancel plus runtime shutdown still drain before closing. The cost is a wider correctness surface: detached runs must be enumerated wherever a hard stop matters (turn cancel, runtime shutdown), a detached recording failure no longer aborts anything — it is logged and surfaced only through `settleDetached()` — and reconciliation now happens after the waiters complete, so a crash in the settlement chain leaves the run open until a later turn's reconcile or recovery settles it. The `detached` flag is opt-in per job, so future background jobs default to today's bound semantics and must consciously opt into outliving the turn.
