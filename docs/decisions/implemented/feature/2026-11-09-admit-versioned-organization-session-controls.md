# Decision Record: Admit versioned organization Session controls

Status: implemented

## Problem

Organization collaborators need to pause or continue the existing execution owner with one durable effect and attributable receipt. A repeated pause can represent a newer human intent even though the native first-pause-wins latch preserves its timestamp. Continue also waits for execution to drain, allowing its connection, signing window or ordered command slot to change before publication.

## Decision

Pause and Continue use the existing service admission, signed transport and Runtime receipt path. Service authorization separates permission to stop from permission to start work: project maintainers and collaborators retain pause access on archived projects, while Continue requires an active project. Visibility and handoff gates apply to both.

The Runtime records an additive per-Session control version. Each new accepted control increments it in the native effect's transaction; a duplicate retains the original receipt and actor. Continue signs both the observed native pause time and this version. A new pause advances the version even when the latch remains unchanged. No historical attribution or control record is backfilled.

Pause owns the native control lock before opening SQL and writes the latch without signalling running tools. Continue enters the target Scope, uses `SessionResume.request` to drain outside SQL, and joins its validation, receipt and final commit guard. The composed commit retains native recovery, command receipt, control version, reception sequence and notifications together. Cancellation ends admission waits without cancelling execution. Native non-admission cannot be adopted as organization acceptance.

An active rejected command explicitly closes its sequence through the existing signed skip protocol. The forwarder returns a conflict only after closure, or reports an unconfirmed closure with the original request ID. Read-only queries reconcile existing evidence and never dispatch a new effect or skip.

## Alternatives considered

**Use only the native pause timestamp.** First-pause-wins deliberately preserves that timestamp, so it cannot distinguish an additional collaborator's pause from the intent a Continue originally observed.

**Call the native abort entry for pause.** Abort signals execution and owned work. It would change pause into physical cancellation and violate the requirement to let existing tools settle.

**Own continuation inside the receiver's transaction.** Native execution drain, Inbox locks and Rollout publication require separate preparation and writer ownership. The existing native admission seam preserves those rules without another scheduler.

**Treat rejection as implicit sequence closure.** Binding and out-of-order rejections need not advance the Runtime watermark. A signed skip gives the service durable evidence instead of guessing from the error category.

## Consequences

The generated organization client exposes `orgCommands.control`. Pause returns a committed latch receipt, while Continue reports durable recovery reception; neither result grants resource access or certifies physical tool completion. Cancellation, resource grants and client presentation remain separate owners.

Real SQL and HTTP/WSS tests cover unchanged-latch pauses, stale versions, native lease preservation, skip during drain, cancellation and expiry, atomic rollback, restart, archived-project authorization, lost acknowledgments and a valid new intent after rejection. The [organization architecture](../../../architecture/organization.md#session-controls) defines current behavior, and the [sequence postmortem](../../../postmortem/0097-rejected-command-blocked-new-control.md) records the discovered recovery gap.
