# Decision Record: Delete automatic restart and crash recovery

Status: implemented

## Problem

Startup assumed that a session interrupted by a process exit wanted to be resumed, and it acted on that assumption. The `resume-pending` step discovered runnable inbox work and continuation-recovery intents, requested drives, and reconciled a `pendingReply` flag back into agreement with the transcript. Automatic repair then terminalized interrupted assistant turns and abandoned workflows it judged phantom.

Two things were wrong with it. The first is that a process restart is evidence that a turn was interrupted and no evidence at all about what the user wants next. Automatically continuing work after a crash can repeat side effects the user had already stopped, and it does so without a request, at a moment the user is not watching. The second is that the machinery could not tell a healthy workflow from an orphan. A BlueprintLoop between turns has no durable driver by design — the continuation kernel re-drives it in-process — so it is indistinguishable in storage from a loop abandoned by a dead process. Automatic recovery was therefore guessing from records that could not answer the question, and when it guessed wrong it destroyed work or pinned a session.

The automatic path also hid its own failures. Startup repair reported that it had handled an interruption while the session stayed stuck, so the log read like a successful recovery and the surviving defect was invisible. Repeated aborts returned success without effect, and the only interaction that cleared the state was a long-press that also cancelled the workflow.

## Decision

Automatic restart and crash recovery are deleted. Recovery happens only because the user asks for it, through the explicit controls.

The startup step is renamed `resume-pending` to `session-pause-reconcile` — in the harness startup chain and at all four anchor call sites — and the change of verb is the decision. `SessionInvoke.reconcilePausedSessions` reconciles interrupted Cortex delegations and parent notifications, then writes the pause latch for every session with direct evidence of an unfinished turn. It never drives. It asks `SessionLifecycle.listUnfinishedSessions` for that evidence rather than for a flag a previous process wrote, so a session whose marker was never persisted is still caught, and a session already carrying a latch is skipped because the latch already records the same fact.

`recoverQueuedTasks` is retired. The intent it carried — an explicit user abort should not silently strand queued work — is preserved by a different mechanism: the pause latch makes the queued items visible as a stopped session awaiting the user, and continue consumes them through the ordinary drive. Internal cancellations keep their no-drive behavior and are strengthened, because they now pass `internalCancel` and do not write a pause at all.

The drive gate no longer consults `RolloutContinuationRecovery`. A drive is gated by the running lease and the pause latch, and the recovery-intent check that used to originate work is gone from the decision. The continuation repair migration still writes and replays its intents, because that is a one-time repair of historical records rather than a runtime recovery path.

`SessionAbort.Result` reports `paused` and drops `settled`. The honest-result requirement is preserved — a caller can still tell a real stop from a no-op — and the meaning of an abort changes with the state model: a user stop leaves the session paused and awaiting an explicit continue or abandon. The escape path for a driverless loop moves from "abort incidentally releases it" to an explicit abandon, which terminalizes the turn and cancels the bound workflow in one action.

Startup adjudication of a BlueprintLoop with no durable driver pauses the session with reason `workflow` and leaves the loop exactly as stored. It no longer judges the loop `failed` with an `interrupted:` error prefix, because a restart is evidence that the turn stopped and not that the user's work should be destroyed, and the loop record is the only handle left for continuing it. Continue and abandon are the two ways out.

## Alternatives considered

**Keep `recoverQueuedTasks` as an intent recorded on the abort.** The flag solved a real problem: after an explicit abort, a durable task queued during the run was left with nothing to consume it, because the loop's abort boundary keeps `task` items and the failed-exit path suppresses the pending-work drive. Keeping it would preserve the drive mechanism while leaving the underlying ambiguity — the flag encoded "this abort was the user's" by enumerating the call sites allowed to set it, so a new user-facing abort entry that forgot the flag would silently strand work again. The latch makes the queued work visible as state rather than as owner bookkeeping, so visibility no longer depends on any caller remembering.

**Keep `RolloutContinuationRecovery` as a drive gate.** The pending-intent check was a reasonable discovery heuristic for work that a migration had deliberately reopened, and removing it looks like losing a capability. It is also recovery originating work: a persisted intent left by a dead process is not evidence the user wants that work resumed now, and treating it as a drive reason reintroduces the same inference this change removes elsewhere. Startup's job is to record what happened, not to act on it. The migration keeps writing intents — they are the durable record that a historical repair reopened a root — and a user continue is what acts on them.

**Resume only sessions whose work was small, or only in some scopes.** A narrower automatic recovery would reduce the blast radius without addressing the premise. The runtime still cannot distinguish an interrupted turn the user wants continued from one they deliberately stopped, and a crash gives it no additional information to narrow on. Any rule would be a guess about intent dressed up as a threshold.

**Keep automatic recovery but log it loudly.** Making the behavior visible does not make it correct. The failure during the incident was not that recovery was quiet — startup logged its decisions — but that it acted on an inference it could not support, and that its success masked the state that was still broken. Logging an unwanted resume does not un-run the model calls it already made.

## Consequences

A restart no longer restarts work. Every session that ended abnormally is recorded as paused and left alone, so an interrupted turn waits for the user instead of continuing behind them. That is a real reduction in assistance: work that used to finish on its own after a restart now requires a person to press continue. The benefit is that no process exit can repeat side effects the user had already stopped, and no session can be pinned by a workflow record that nothing drives.

The honest states are now the visible ones. A stopped session reports `paused` with a reason and a description, a driverless loop leaves its session paused with reason `workflow` instead of terminalizing the loop, and the abandonment of an orphan is an explicit user action rather than an incidental effect of aborting. Startup's failure modes are also narrower: reconciliation isolates failures per session, and a failed latch write is a warning rather than a silent success.

The cost is that the recovery surface is larger in one direction and smaller in another. Losing `recoverQueuedTasks` and the continuation-recovery drive gate removes two reasons a drive could originate, which makes the drive gate simpler and stricter, but it means the queued-work path now depends entirely on the user continuing the session. Sessions that were previously auto-resumed after a crash stay paused until someone acts, including sessions whose interruption the user never noticed.

Cross-references: the state that replaces automatic recovery is recorded in [session paused state authority](../../implemented/architecture/2026-09-20-session-paused-state-authority.md), and the controls that act on it are recorded in [session continue and abandon controls](../../implemented/feature/2026-09-20-session-continue-and-abandon-controls.md). The intent preserved by a different mechanism comes from [abort inbox stranding](../../implemented/bug-fix/2026-08-21-abort-inbox-stranding.md), and the adjudication this replaces is [persisted workflow liveness adjudication](../../implemented/architecture/2026-09-19-persisted-workflow-liveness-adjudication.md).
