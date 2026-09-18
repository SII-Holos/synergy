# Decision Record: Adjudicate persisted workflow liveness at startup

Status: implemented

## Problem

A Runtime that died with a BlueprintLoop mid-flight could leave that loop persisted as `running` with nothing that would ever resume it.

`SessionExecutionContributions.isActive` decided whether a session was still working by reading the persisted status of the session's bound BlueprintLoop. That test cannot distinguish a loop being driven from a loop abandoned by a dead process, so an orphaned record kept `SessionWorking.resolve()` returning `recovering`. The pin was self-sealing: the derived status is recomputed from the same record, so every recomputation confirmed the previous one and no user-facing control could clear it. Abort returned HTTP 200 without effect seven times in a row, and the session only unblocked through a two-second long-press that additionally cancelled the loop.

Startup reconciliation (`WorkflowRecovery.reconcileRuntimeScope`) made this durable rather than transient. It restored loop, session, and note bindings but never adjudicated whether the loop was still alive, and the startup re-drive discovery set did not include active BlueprintLoops, so recovery faithfully rebuilt a record that no runtime owned.

## Decision

A persisted active loop is a real driver only when durable evidence says something will resume it. `WorkflowRecovery.hasResumableEvidence` accepts four cases and rejects everything else:

- a `waiting` loop, which is user-paused and awaits an explicit resume rather than a driver;
- a loop with a `stopRequest`, because stop-intent recovery re-drives the execution session;
- a loop with `source === "lattice"`, because Lattice creates, starts, and reconciles its own loops in its startup controller, which runs after session recovery;
- a loop whose bound session has a runnable inbox item or a pending continuation-recovery intent, since either will drive the session.

Anything else is adjudicated in `adjudicateOrphanedLoop` and terminalized. An orphaned `armed` loop becomes `cancelled`, because `armed` has no in-flight work to fail and `failed` is not a legal transition from `armed` (`TRANSITIONS.armed = ["running", "cancelled"]`). A started loop becomes `failed` with an error prefixed `interrupted:`, so an adjudicated loop is distinguishable in stored history from one that failed through its own lifecycle.

Because the terminal branch of reconciliation already clears the session loop binding and the note's `activeLoopID`, adjudication reuses it: the adopted terminal status flows into the existing reference-clearing logic, and the note can start a new loop afterwards.

Adjudication is ordered before binding restoration. Restoring first would rebuild exactly the session and note references that adjudication then has to remove.

The same evidence test serves explicit user stops. `WorkflowRecovery.hasResumableEvidence` is exported and reused by the abort path, so a loop kept alive by real evidence can never be abandoned by an abort while an orphaned one can be released without a restart.

## Alternatives considered

**Publish an idle status without clearing the persisted loop.** This cannot work while the status stays derived. The client obtains it from `listStatuses` through `recoverableStatuses` and `Working.resolve`, and every one of those recomputes the status from the same loop record. Masking the symptom at one presentation layer would leave the next reader of that status pinned. The phantom record has to become terminal, not be described differently.

**Auto-resume orphaned loops on startup.** This was rejected by the user as out of scope for this change, and it would have required inventing a runtime writer for continuation-recovery intents, which today only migrations write. Resuming also decides for the user that abandoned work should continue, which is a product decision rather than a recovery detail.

**Add a non-terminal `interrupted` loop status with explicit continue and abandon actions.** Semantically the most faithful option, and it would let a user choose. It touches the session schema, the OpenAPI document, the generated SDK, and every frontend path that renders a loop status, for a state that no runtime drives. The existing terminal branch plus an `interrupted:` error prefix carries the same information at no schema cost.

**Terminalize every active loop unconditionally.** This destroys two documented resume paths. Lattice reconciles its own loops after session recovery and must find them intact, and a `waiting` loop is a user pause that only an explicit resume clears. Both are legitimate live states that a blanket rule would silently kill.

## Consequences

A session can no longer be pinned indefinitely by a workflow record with no driver. Startup recovery now produces a terminal loop and a clearable session instead of a permanent `recovering` state, and the reason is visible to the user rather than encoded in a log line.

The cost is that adjudication runs against every active loop in the runtime scope during startup reconciliation, requiring an inbox and continuation-recovery read per loop. A loop whose only resume evidence existed in the dead process's memory is now terminalized rather than left intact, which is the intended outcome but does mean recovery no longer preserves every active record it finds.

`packages/product-runtime/test/session/loop-liveness-adjudication.test.ts` covers the terminalization, the reference clearing, the `armed`-becomes-`cancelled` transition, resuming a Blueprint after adjudication, and preservation of a user-paused loop, a loop awaiting review through its stop intent, a loop whose session has runnable inbox work, a Lattice-owned loop, and a loop that already reached a terminal status. Abort-side behavior is covered by `packages/product-runtime/test/session/abort-escape-hatch.test.ts` and recorded in [abort outcome fidelity and driverless workflow release](../../implemented/bug-fix/2026-09-19-abort-outcome-fidelity-and-driverless-workflow-release.md). The incident is recorded in the [host-suspend postmortem](../../../postmortem/0017-host-suspend-pinned-session-in-recovering.md), and the resulting behavior is documented in [Workflow Runtime](../../../architecture/workflows.md).
