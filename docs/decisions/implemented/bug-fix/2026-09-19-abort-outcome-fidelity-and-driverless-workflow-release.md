# Decision Record: Report abort truthfully and release a driverless workflow

Status: implemented

## Problem

`POST /:sessionID/abort` unconditionally returned `c.json(true)`. The response carried no information about what the call did, and nothing in the route inspected whether anything had happened.

That mattered because abort has two independent jobs and can silently fail at both. `SessionManager.signalAbort` returns `"not_found"` when no runtime exists, so aborting a session with no live loop stops nothing. `repairAfterAbort` deliberately refused to publish idle while `SessionWorking.resolve()` was truthy, and a phantom BlueprintLoop kept it truthy with no runtime driving it. Neither condition reached the caller.

During the [host-suspend incident](../../../postmortem/0018-host-suspend-pinned-session-in-recovering.md), a user pressed abort seven times over 54 seconds on a session pinned by exactly that phantom loop. Every request returned HTTP 200. Only a two-second long-press on the Blueprint slot icon freed the session, because that gesture is the one path that also cancels the loop.

An abort that reports success without effect is worse than an error. It consumes the user's attempts and hides the remedy.

## Decision

`SessionAbort.abort` returns a `SessionAbort.Result` describing what it did. `outcome` carries the real runtime signal result — `not_found`, `idle`, `signaled`, `already_stopping`, or `not_owner` — where `not_found` and `idle` both mean no running turn was stopped. `repaired` reports an interrupted turn whose in-flight tool parts were settled, `abandoned` reports a workflow cancelled because the user abandoned the session, and **`paused`** reports that the session was left paused awaiting an explicit continue; the earlier `settled` field is gone, because a user stop now latches a pause rather than publishing idle. The route returns that result instead of a constant. See [session paused state authority](../../implemented/architecture/2026-09-20-session-paused-state-authority.md).

`SessionAbort.hadEffect(result)` reads it: a real signal (`signaled` or `already_stopping`) counts, and so does any state change this call made, but an abort that found an idle session with nothing to stop reports no effect.

**The escape path is replaced.** `repairAfterAbort` no longer abandons a workflow on its own initiative — it cancels a bound workflow only when the caller passes `abandonWorkflow`, which is what `session.abandon` does. The driverless-loop release therefore moves from "an abort incidentally releases the workflow" to an explicit Abandon action that terminalizes the interrupted turn and cancels the bound workflow in one deliberate step. Startup adjudication covers the restart case by pausing the session and leaving the loop intact; see [persisted workflow liveness adjudication](../../implemented/architecture/2026-09-19-persisted-workflow-liveness-adjudication.md). A stop that is not an abandon never cancels a workflow, so "stop this turn" can no longer turn into "terminate the workflow" for a healthy loop.

A repeat abort republishes the resolved status rather than unconditionally publishing idle: `repairAbortState` resolves the session's status and publishes exactly that, so a second abort on a paused session re-reports `paused` and a settled session reports `idle`. Idle is still published only when the resolution is clear, so a repeat abort does not emit the duplicate lifecycle signal continuation consumers would act on.

## Alternatives considered

**Make abort unconditionally cancel any active workflow.** This breaks the established split in which abort stops the current turn and cancellation of a workflow is a separate explicit action. It would also silently terminate healthy loops: a running Lattice-owned loop or a BlueprintLoop mid-review is real work, and an abort aimed at a stuck turn must not decide that the user wants the workflow gone.

**Fix only the route's response payload.** Reporting `not_found` honestly is necessary but not sufficient — the user would have learned that abort was doing nothing while still being unable to unblock the session. Fidelity without an escape hatch leaves the incident unresolved.

**Gate abandonment on something weaker than "no live runtime owns the session".** Any weaker condition risks abandoning a loop that a live loop or startup reconciliation is about to drive, producing a terminal loop for work that would have completed. The liveness check is the whole safety property, and the evidence test is what makes it precise rather than merely conservative.

## Consequences

Every abort reports what it did, so a no-op is distinguishable from a stop without reading logs. Operators can tell a session that was stopped from one that had nothing running, which the previous unconditional success made impossible, and a user stop now visibly leaves the session paused and awaiting a continue or abandon instead of resting as if the work had finished. The remedy is a labelled control rather than an undocumented gesture.

The cost is a wider abort path: abort now performs a durable workflow write in addition to signalling the runtime, so it can fail in more ways and must hold the no-live-runtime check before that write. Abort also becomes a release route for orphaned loops, which means two paths can terminalize a BlueprintLoop — this one and restart adjudication. They are consistent by construction, sharing `hasResumableEvidence` and differing only in the terminal status they choose, but that duplication must be maintained deliberately.

`packages/presets/test/session/abort-escape-hatch.test.ts` covers freeing a session pinned by a phantom loop while reporting the effect, reporting no effect on an idle session with nothing to stop, reporting the runtime outcome for a live turn that was actually stopped, and preserving a loop held by a durable driver, a Lattice-owned loop, and a user-paused loop. The liveness invariant these paths share is recorded in [persisted workflow liveness adjudication](../../implemented/architecture/2026-09-19-persisted-workflow-liveness-adjudication.md), and the user-visible behavior is documented in [Sessions and Messages](../../../architecture/session-and-messages.md).
