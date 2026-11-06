# Decision Record: A user start releases the pause latch; a machine start refuses it

Status: implemented

## Problem

`BlueprintLoopService.start` bound the session, moved the loop to `running`, and delivered the first prompt without settling an existing pause. The drive gate refuses a paused interactive session, so the delivery parked in the inbox and never materialized: the loop, the Note's `activeLoopID`, and `session.blueprint.phase` all reported a run whose turn never started, and no message reached the transcript. Reloading could not recover it, because the work was never written as a message.

The stuck state was also self-sealing. The Note recorded the phantom loop as active, so arming the same Blueprint again failed with `This Blueprint already has an active run`, and starting a `running` loop is not a legal transition. Only cancel-then-create escaped it.

The same class existed on two more paths. `SessionInvoke` started a turn against the latch, aborted it on the first iteration, and then reported the _previous_ turn's terminal error as this prompt's outcome — the path ACP uses. And a machine-owned loop (`source: "lattice"` or `"plugin"`) could claim `running` under the latch for work its owner would never drive.

## Decision

Take-back has one definition in `SessionLifecycle`, because the steps and their order are the same for every caller: drain the stopping turn, decide the interrupted rollout run, then clear the latch. Draining comes first because clearing the latch while the stopping turn still holds its lease lets its next iteration observe "not paused" and continue the work the user stopped.

Both take-back entries tolerate an absent Session only when storage reports `Storage.NotFoundError`. Busy, integrity and read failures propagate before any further lifecycle transition; a failed read cannot establish that there is no pause to release. The lifecycle regression exercises this invariant for start and resume alongside the other latch operations.

The two ways a user takes a session back differ only in the rollout run, and that difference is the caller's decision rather than an implementation detail. `startNewTask` leaves the interrupted run closed, because the new task root owns a fresh run. `resume` reopens that run so the next turn appends to it. Explicit continue and steering input use `resume`; new human input and a user-owned loop start use `startNewTask`. The local runtime keeps no private copy of either.

`BlueprintLoopService.start` settles the latch before it writes anything, so a blocked start leaves neither a binding nor a `running` claim behind. A user-owned loop releases the pause, because the first prompt is a new task root and the user's explicit action is the take-back. A machine-owned loop throws `LoopError.SessionPaused`, because only the user releases a stop the user asked for; the owner decides what a blocked start means for its own lifecycle.

Lattice treats that error as a deferral: the loop stays `armed` and the next reconcile after the user continues starts it. Recording a Run pause instead would restore the second pause authority the session latch replaced.

`SessionInvoke` releases the latch for explicit human input, so a prompt and an input reach the same admission instead of the turn aborting against the latch and echoing an unrelated failure. Passive and machine input keep the latch.

## Alternatives considered

**Clear the latch inside delivery rather than before it.** Delivery is asynchronous and its failure terminalizes the loop. Settling afterwards would leave a window where the loop is bound and `running` while the latch still refuses the drive, which is the same phantom state this change removes.

**Let a user-owned start resume the interrupted run instead of starting a new task.** The first prompt is a new task root with its own rollout run, so reopening the previous run would append an unrelated root to evidence that describes different work.

**Release the latch for machine-owned starts too.** A domain restarting work the user stopped is the defect the latch exists to prevent. The failure is also invisible where it happens, because the machine source has no user watching its own claim.

**Pause the Lattice Run when the start is blocked.** It records a second pause authority for one user-visible concept, which is exactly what the session latch replaced. Deferring leaves the Run `active` and the loop `armed`, and the effect re-runs after the user continues.

**Show the parked prompt in the Composer as the remedy.** The queued item carries `origin: "blueprint"`, so the pending-row selector keeps it out of the pending stack. Making the invisible state visible would still leave a loop that reports `running` without a turn; the state itself had to go.

## Consequences

Starting a Blueprint after a failure now runs, and the transcript shows the first prompt. A paused session cannot be driven by a machine-owned start, so `Lattice` introduces a reconcile pass after the user continues rather than resuming behind their back. The local runtime no longer owns admission semantics that belong to the latch.

`SessionLifecycle.startNewTask` and `resume` replace the private `takeSessionBack` copy that lived in `packages/local-runtime/src/session-api.ts`. The removed `BlueprintLoopService.createAndStart` had no caller and was deleted rather than kept as a second entry point.

Explicit human input through `SessionInvoke` now clears the latch before the user message is written, so the ACP path reports its own outcome instead of the previous turn's error. Machine and passive injection still leave the latch intact.

Regression coverage is `packages/blueprint/test/blueprint/start-takes-session-back.test.ts`, which asserts that a user start releases the latch before delivery and that a machine start throws without writing a binding or a `running` claim.
