# Decision Record: Continue completed roots for unanswered steering

Status: implemented

## Problem

Cortex execution belongs to the root that launched the child, while its completion notification steers the parent's latest root. A newer root can complete its Rollout while the older root's child remains active. The notification then becomes an unanswered message on a run that refuses new execution. A pause after materialization also leaves explicit Continue unable to admit recovery against that completed run.

## Decision

The Session loop continues a completed Rollout only after canonical history establishes an unanswered input following a terminal reply on the selected root. This check and the next segment admission run under the existing Session control and per-root settlement locks. `RolloutLedger.continueRun` owns the journaled transition, retaining input, configuration, provenance and prior execution records while clearing aggregate completion and changing recording to partial.

Automatic continuation accepts only a completed run with usable recording and no cancellation request. Ordinary call and segment writers retain their terminal guards. Failed, cancelled and interrupted work keep their separate recovery policies; a recording failure in memory also prevents reopening when its durable marker could not be written.

Explicit Continue can use this transition when a completed root already contains unanswered input. Its Inbox admission, recovery receipt and pause release commit with the Rollout transition through the existing journal callback. Completed roots without pending input remain protected by the ordinary resume policy. No startup sweep, schema change or automatic release of a pause is introduced.

This extends the admission locking established by [continuation settlement](2026-09-10-rollout-continuation-settlement.md) and the explicit recovery admission in [durable Continue](2026-10-23-durable-session-continue.md).

## Alternatives considered

**Deliver to the child's original root.** This contradicts latest-root steering and can send the completion behind newer user direction. Child lineage remains historical attribution rather than notification scheduling.

**Keep every newer run open while any child exists.** This couples unrelated roots' completion to all background work and still does not define admission for a later steer after valid completion.

**Reopen from every terminal ledger write.** Auxiliary calls and stale tool work could revive finished tasks without new input. The dedicated transition requires the Session caller to establish a continuation.

**Use only freshly drained Inbox items as proof.** A notice already materialized before a failure or restart would remain unable to continue. Canonical pending-input semantics cover both delivery stages.

## Consequences

One root can retain multiple completed execution segments and accept another segment for newly admitted input. Earlier replies, calls and tools remain unchanged; automatic notification recovery stays deduplicated and full result retrieval still acknowledges Cortex completion. Run-level completion is provisional with respect to later steering, while individual execution evidence remains terminal.

The real-runtime regression launches a delayed Cortex task, completes a newer root, releases the child, retrieves its result and finishes on the newer root. It checks two roots, one notification, one delegation, preserved earlier segments and no repeated model call after notification reconciliation. Focused tests cover saved-notification Continue, admission idempotence and cancellation or recording failures. [The postmortem](../../../postmortem/0092-cortex-notification-targeted-completed-root.md) records the failure mechanism.
