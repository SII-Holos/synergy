# Decision Record: Admit organization task cancellation through the native owner

Status: implemented

## Problem

An organization cancellation can finish receiving while its target execution is still draining. Waiting for physical drainage before acknowledging reception makes a slow tool look like an unknown command. Returning early without retaining ownership lets shutdown close storage under unfinished cancellation. Repeating an old cancel after Continue can stop newly resumed work.

## Decision

The signed control payload identifies the native run and observed Runtime control version. Current Session stop authorization permits cancellation in archived projects; project visibility, execution role and handoff gates still apply. The Runtime serializes cancellation with other controls and rechecks its binding, sequence, version and signing window inside native admission.

The existing Rollout cancellation owner commits cancel intent, matching Inbox removal and the organization receipt together. Its post-commit callback acknowledges reception before physical signals and drainage finish. The bridge sends the first validated reply once while retaining the original callback and bounded capacity slot until completion. Connection shutdown drains that callback before storage closes. The native Session control lock remains held through drainage.

Accepted receipts retain the original actor, run status at reception and cancel intent. Duplicate requests return that immutable fact without invoking cancellation again, including after the same root resumes. Missing native runs have a specific error that preserves the existing storage-not-found superclass; unrelated admission failures are never converted into a missing target. Current execution and physical process completion remain separate observations.

## Alternatives considered

**Wait for full drainage before replying.** A durable accepted cancellation could exceed transport deadlines and appear unreceived while its tool was still exiting.

**Detach cancellation after returning the receipt.** A separate background promise would lose the bridge's capacity and shutdown ownership, and releasing the control lock could let delayed drainage stop a later continuation.

**Use the pause latch as cancellation.** Pause preserves active tool lifecycles and does not express native run cancellation.

## Consequences

Reception can return 202 while execution remains active. Disconnect after commit does not withdraw cancellation, and a later failure cannot replace the accepted reply. Unknown physical completion requires independent execution evidence. Long drainage retains a bounded command slot and can delay shutdown; reconciliation and heartbeats remain available through their separate transport paths.

Protocol, native intake, real WSS and public-service tests cover explicit roots and versions, archived authorization, publication rollback, deadline and connection fences, control serialization, early reception, shutdown drainage and duplicate requests after native resumption. Existing continuation tests retain their original pause semantics.
