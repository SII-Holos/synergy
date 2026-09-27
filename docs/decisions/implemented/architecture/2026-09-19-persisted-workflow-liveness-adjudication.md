# Decision Record: Adjudicate persisted workflow liveness at startup

Status: implemented

## Problem

A Runtime that died with a BlueprintLoop mid-flight could leave that loop persisted as `running` with nothing that would ever resume it.

`SessionExecutionContributions.isActive` decided whether a session was still working by reading the persisted status of the session's bound BlueprintLoop. That test cannot distinguish a loop being driven from a loop abandoned by a dead process, so an orphaned record kept `SessionWorking.resolve()` reporting the session as still needing attention. The pin was self-sealing: the derived status is recomputed from the same record, so every recomputation confirmed the previous one and no user-facing control could clear it. Abort returned HTTP 200 without effect seven times in a row, and the session only unblocked through a two-second long-press that additionally cancelled the loop.

Startup reconciliation (`WorkflowRecovery.reconcileRuntimeScope`) made this durable rather than transient. It restored loop, session, and note bindings but never adjudicated whether the loop was still alive, and the startup re-drive discovery set did not include active BlueprintLoops, so recovery faithfully rebuilt a record that no runtime owned.

## Decision

**The liveness test is replaced.** A persisted active loop is a real driver only when durable evidence says something will resume it, and the question is now asked by `hasDurableDriver`, which accepts three cases and rejects everything else:

- a loop with a `stopRequest`, because stop-intent recovery re-drives the execution session;
- a loop with `source === "lattice"`, because Lattice creates, starts, and reconciles its own loops in its startup controller, which runs after session recovery;
- a loop whose bound session is currently running, or whose bound session has durable driver evidence.

The earlier `waiting` case is gone with BlueprintLoop's `waiting` status: a loop no longer owns a pause state, so nothing is preserved on that ground.

Anything else is adjudicated in `adjudicateOrphanedLoop`. **The outcome is replaced:** adjudication no longer terminalizes the loop or writes an `interrupted:`-prefixed error. It pauses the session with reason `workflow` and leaves the loop record exactly as stored, because a restart is evidence that the turn stopped and not that the user's work should be destroyed, and that record is the only handle left for continuing it. Continue and Abandon are the two ways out. Recorded in [session paused state authority](../../implemented/architecture/2026-09-20-session-paused-state-authority.md) and [delete automatic restart recovery](../../implemented/bug-fix/2026-09-20-delete-automatic-restart-recovery.md).

Adjudication writes only the session latch. The loop, its session binding, and the note's `activeLoopID` are left untouched, because nothing about this outcome is terminal: the record stays valid for whichever choice the user makes.

Adjudication still runs before binding restoration, and a session already carrying the latch is skipped, so a repeated reconcile pass does not rewrite a pause the user has already seen.

**The abort path no longer decides liveness.** An abort used to reuse the exported evidence test to release an orphaned loop incidentally. Adjudication now owns the restart case on its own — it pauses the session and leaves the loop intact — and a workflow is cancelled only when the user explicitly abandons the session, so no abort has to judge whether a loop has a driver.

## Alternatives considered

**Publish an idle status without clearing the persisted loop.** This cannot work while the status stays derived. The client obtains it from `listStatuses` through `recoverableStatuses` and `Working.resolve`, and every one of those recomputes the status from the same loop record. Masking the symptom at one presentation layer would leave the next reader of that status pinned. The phantom record has to become terminal, not be described differently.

**Auto-resume orphaned loops on startup.** This was rejected by the user as out of scope for this change, and it would have required inventing a runtime writer for continuation-recovery intents, which today only migrations write. Resuming also decides for the user that abandoned work should continue, which is a product decision rather than a recovery detail.

**Add a non-terminal `interrupted` loop status with explicit continue and abandon actions.** Semantically the most faithful option, and it would let a user choose. It touches the session schema, the OpenAPI document, the generated SDK, and every frontend path that renders a loop status, for a state that no runtime drives. The existing terminal branch plus an `interrupted:` error prefix carries the same information at no schema cost.

**Terminalize every active loop unconditionally.** This destroys two documented resume paths. Lattice reconciles its own loops after session recovery and must find them intact, and a user pause is a state that only an explicit resume clears. Both are legitimate live states that a blanket rule would silently kill. (A loop no longer carries its own pause status; the user-pause case is now the session latch, which a blanket loop terminalization would still silently override.)

## Consequences

Unreadable Inbox or continuation evidence is unknown liveness, never evidence of absence. Storage errors propagate into the existing recovery failure report and preserve the active loop for a later retry. An explicit abort no longer abandons a workflow at all, so a failed evidence read has nothing to endanger there.

A session can no longer be pinned indefinitely by a workflow record with no driver. Startup recovery now pauses the session with reason `workflow` and leaves the loop intact, so the session is clearable instead of permanently stuck, and the reason is visible to the user rather than encoded in a log line. The user's escape is an explicit Continue or Abandon rather than an abort that incidentally releases the loop; see [session continue and abandon controls](../../implemented/feature/2026-09-20-session-continue-and-abandon-controls.md).

The cost is that adjudication runs against every active loop in the runtime scope during startup reconciliation, requiring a durable-driver read per loop. A loop whose only resume evidence existed in the dead process's memory is left intact but not resumed, which is the intended outcome but does mean recovery no longer acts on every active record it finds — it records the session as paused and waits. Adjudication also no longer resolves the loop, so a session paused this way stays paused until the user chooses, and the loop's identity is preserved for whichever choice they make.

`packages/presets/test/session/loop-liveness-adjudication.test.ts` covers the adjudication outcome for a loop with no durable driver and the preservation of a loop that has one, including a loop carrying a stop intent, a Lattice-owned loop, and a loop whose session is running. Abort-side behavior is covered by `packages/presets/test/session/abort-escape-hatch.test.ts` and recorded in [abort outcome fidelity and driverless workflow release](../../implemented/bug-fix/2026-09-19-abort-outcome-fidelity-and-driverless-workflow-release.md). The incident is recorded in the [host-suspend postmortem](../../../postmortem/0018-host-suspend-pinned-session-in-recovering.md), and the resulting behavior is documented in [Workflow Runtime](../../../architecture/workflows.md).
