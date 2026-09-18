# Decision Record: Report abort truthfully and release a driverless workflow

Status: implemented

## Problem

`POST /:sessionID/abort` unconditionally returned `c.json(true)`. The response carried no information about what the call did, and nothing in the route inspected whether anything had happened.

That mattered because abort has two independent jobs and can silently fail at both. `SessionManager.signalAbort` returns `"not_found"` when no runtime exists, so aborting a session with no live loop stops nothing. `repairAfterAbort` deliberately refused to publish idle while `SessionWorking.resolve()` was truthy, and a phantom BlueprintLoop kept it truthy with no runtime driving it. Neither condition reached the caller.

During the [host-suspend incident](../../../postmortem/0017-host-suspend-pinned-session-in-recovering.md), a user pressed abort seven times over 54 seconds on a session pinned by exactly that phantom loop. Every request returned HTTP 200. Only a two-second long-press on the Blueprint slot icon freed the session, because that gesture is the one path that also cancels the loop.

An abort that reports success without effect is worse than an error. It consumes the user's attempts and hides the remedy.

## Decision

`SessionAbort.abort` returns a `SessionAbort.Result` describing what it did. `outcome` carries the real runtime signal result — `not_found`, `idle`, `signaled`, `already_stopping`, or `not_owner` — where `not_found` and `idle` both mean no running turn was stopped. `repaired` reports an interrupted turn that was terminalized, `abandoned` reports a workflow terminalized because nothing durable drove it, and `settled` reports that idle was published because this call cleared the last work. The route returns that result instead of a constant.

`SessionAbort.hadEffect(result)` reads it: a real signal (`signaled` or `already_stopping`) counts, and so does any state change this call made, but an abort that found an idle session with nothing to stop reports no effect.

The second half fixes the case in the incident. `repairAfterAbort` now abandons a workflow that claims activity while no durable driver exists. Two guards keep that safe. It only runs after establishing that no live runtime owns the session, and it is scoped to BlueprintLoops: Light Loop and Lattice own their own restart reconciliation and are never touched by this path. Within BlueprintLoops it reuses the exported `WorkflowRecovery.hasResumableEvidence` test, so a loop kept alive by a stop intent, runnable inbox work, a continuation-recovery intent, a Lattice source, or a user pause is preserved. User-requested abandonment writes `cancelled` with `"Stopped by user request"`, which is deliberately distinct from restart adjudication's `failed` with an `interrupted:` error.

A repeat abort still does not republish idle. Idle is published only when this call changed durable state and `SessionWorking.resolve()` is then clear, so a second abort on a settling session reports its outcome without emitting a duplicate lifecycle signal for continuation consumers.

## Alternatives considered

**Make abort unconditionally cancel any active workflow.** This breaks the established split in which abort stops the current turn and cancellation of a workflow is a separate explicit action. It would also silently terminate healthy loops: a running Lattice-owned loop or a BlueprintLoop mid-review is real work, and an abort aimed at a stuck turn must not decide that the user wants the workflow gone.

**Fix only the route's response payload.** Reporting `not_found` honestly is necessary but not sufficient — the user would have learned that abort was doing nothing while still being unable to unblock the session. Fidelity without an escape hatch leaves the incident unresolved.

**Gate abandonment on something weaker than "no live runtime owns the session".** Any weaker condition risks abandoning a loop that a live loop or startup reconciliation is about to drive, producing a terminal loop for work that would have completed. The liveness check is the whole safety property, and the evidence test is what makes it precise rather than merely conservative.

## Consequences

The user's first abort attempt on a pinned session now frees it, and every abort reports what it did, so a no-op is distinguishable from a stop without reading logs. Operators can tell a session that was stopped from one that had nothing running, which the previous unconditional success made impossible.

The cost is a wider abort path: abort now performs a durable workflow write in addition to signalling the runtime, so it can fail in more ways and must hold the no-live-runtime check before that write. Abort also becomes a release route for orphaned loops, which means two paths can terminalize a BlueprintLoop — this one and restart adjudication. They are consistent by construction, sharing `hasResumableEvidence` and differing only in the terminal status they choose, but that duplication must be maintained deliberately.

`packages/product-runtime/test/session/abort-escape-hatch.test.ts` covers freeing a session pinned by a phantom loop while reporting the effect, reporting no effect on an idle session with nothing to stop, reporting the runtime outcome for a live turn that was actually stopped, and preserving a loop held by a durable driver, a Lattice-owned loop, and a user-paused loop. The liveness invariant these paths share is recorded in [persisted workflow liveness adjudication](../../implemented/architecture/2026-09-19-persisted-workflow-liveness-adjudication.md), and the user-visible behavior is documented in [Sessions and Messages](../../../architecture/session-and-messages.md).
