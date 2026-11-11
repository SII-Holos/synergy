# Decision Record: Suspend native Cortex for maintenance

Status: implemented

## Problem

Stopping a Runtime cancels its delegated work. A backup needs native Cortex writers to drain while retaining their task, input, output contract, budget, deadline and parent-notification identity. A connection close, an empty live task map or a changed task status cannot prove those writers stopped.

## Decision

Cortex contributes one actual owner to `RuntimeMaintenance`. An explicit maintenance walk reads canonical child Sessions across Scopes, validates their status and suspends active native tasks through the existing admission lock, turn-abort, idle wait, tracked background work and capacity owners. A versioned `Session.cortex.maintenance` hold retains the original native controls. It does not set the parent or unattended child paused, cancel the task, create another task or fabricate a transfer epoch.

The current opaque maintenance lease validates suspension, inspection and source release. Missing live owners, unknown status schemas, plugin writers without their exact generation owner, cancellation races and incomplete native work prevent a freeze receipt. Existing transfer tasks remain under their own authority only with the exact source handoff's final frozen or surrendered epoch proof. A draining source intent or ancestor admission hold is insufficient, even when the execution gate reports that Session frozen. A cold Runtime cannot reconstruct missing budgets or claim the old cohort's controls.

Source release records readiness and restores the retained controls to the original in-memory task. It performs no model call and adds no input or completion notification. An explicit native start after global maintenance release validates current execution ownership and transfer admission, then resumes the original admitted root through the canonical continuation receipt. An unadmitted task keeps its reserved initial input. The absolute deadline is checked before model admission; elapsed maintenance time cannot buy another model call after expiry.

Only one current native continuation hold survives a subsequent suspension. Starting maintenance may replace an already resumed transfer hold; a later handoff may replace an already released maintenance hold. The new canonical hold and its derived index publish in the same transaction. Neither operation releases an active hold owned by the other. Terminal publication removes both derived hold indexes. Public Session summaries omit maintenance controls and transfer controls.

The owning maintenance migration rebuilds the derived maintenance-to-child index without rewriting canonical task controls. Unknown hold schemas remain on disk and reject preparation. Handoff drainage retries use the exact current source intent and aggregate binding while that source remains draining; only a genuinely frozen source uses its final epoch proof. Cancelled sources and reused handoff epochs cannot resume owner preparation.

## Alternatives considered

**Call Runtime close or Cortex cancellation.** Those paths change delegated task state and can discard queued work instead of retaining its continuation.

**Reuse the transfer hold for maintenance.** A backup has no transfer handoff or destination epoch. Sharing that authority would let one operation release another's execution fence.

**Replay the original task after release.** It duplicates native input and can repeat effects or structured-output repair. Retained root admission and continuation receipts preserve the actual execution boundary.

**Trust only the in-memory task registry.** A missing active canonical child is unresolved physical ownership, not a completed or unlimited task. Maintenance must report that gap.

## Consequences

This supplies actual native Cortex suspension and source-continuation controls. It does not supply every Process, Environment, Workspace or external plugin writer proof, a cold-cohort takeover policy, hosted reader fencing or a complete deployment backup. Those owners remain necessary before an operator can call a deployment frozen or recovered. Restore-purpose holds cannot enter the source-release path.

## Verification

`test/cortex/maintenance.test.ts` uses real temporary Runtime/SQLite fixtures and a synthetic Provider SDK running through the actual model loop. It verifies model abort/drain, unchanged task/root/parent state, retained budgets, no model call on release, one original root and one parent notification after explicit continuation, and no additional model call after the retained deadline. Other cases exercise queued tasks, cold ownership, unknown status and hold schemas, derived-index reconstruction and maintenance-to-handoff replacement. Live and cold draining transfer counterexamples reject maintenance; exact frozen and surrendered source proofs retain the independent transfer hold. `test/cortex/transfer-retry.test.ts` verifies exact draining retries and cancelled/foreign/reused-epoch rejection. Existing running and structured-repair handoff regressions remain selected.

## Related

- [Cortex](../../../architecture/cortex.md)
- [Purpose-bound maintenance](2026-11-11-retain-purpose-bound-runtime-maintenance-holds.md)
- [Native Cortex handoff controls](2026-11-11-preserve-native-cortex-handoff-controls.md)
