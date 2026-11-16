# Decision Record: Drain accepted Workspace moves before native release

Status: implemented

## Problem

WorkspaceMove release could inspect the original coordinator identity before an accepted native hold created its durable claim. Release then cleared dispatch, but the hold later created a claim and failed to publish its reference because the target reservation was terminal. The move no longer retained the evidence needed to discover that orphan during maintenance. See [the postmortem](../../../postmortem/0145-workspace-move-release-outpaced-native-admission.md).

## Decision

The existing Runtime job map owns the finite accepted run. Each job captures its original Runtime/Store/artifact guard independently of the request's signal. Public release snapshots that exact job before its first await and verifies its owner. Reusing an accepted run checks the same original owner.

Release first records its permanent outcome and removes the target range reservation in the original transaction. It retains `nativeRequested` and any native reference while the accepted run settles. The terminal state prevents that run from publishing a new capture or head. After drainage, release rechecks the original owners and invokes the existing native finalizer, which inspects or releases the same native identity through the provider's original coordinator ledger. Only confirmed completion clears native dispatch and reference fields.

Drainage observes both successful and rejected completion. It does not authorize a replacement capture or suppress native reconciliation failures. A cancelled run signal does not prevent cleanup under the original signal-independent Storage owner. Uncertain release continues to retain the original intent evidence for retry.

An execution-local context carries the same job owner's identity only during that run. Public release called from its own accepted source callback rejects before a terminal write, preventing self-waiting. The ordinary execution path calls the private native finalizer and does not wait for its own job. A callback inherited after the original job ends has no accepted job to match.

## Alternatives considered

**Inspect the native ledger immediately after terminal publication.** An accepted hold may not have written its claim yet. An empty observation does not drain its producer.

**Release the range only after the run finishes.** That lets a run continue toward publication while cancellation waits. The terminal decision must stop publication first while retaining native evidence.

**Clear dispatch and repair a later orphan.** That discards the original maintenance evidence and would require a second recovery inventory. The existing intent and coordinator already own the necessary identity.

**Always wait for an accepted job, including reentrant release.** A source callback would wait for the run that is waiting for that same callback. Explicit rejection preserves the current operation without a deadlock or a new coordinator.

## Consequences

External release can wait for already accepted native admission or source I/O. Its completion now proves that the original run settled and its native claim was actually released; it does not delete source files or undo published target data. Native uncertainty remains visible through the original intent and maintenance inspection.

The real coordinator regression reproduces the former orphan before the fix. Additional source callback and original-signal cancellation cases verify rejection and cleanup behavior. Existing move receipts, publication CAS, cold recovery and unsupported target restrictions remain owned by [the original move decision](../architecture/2026-11-12-publish-native-workspace-moves-with-retained-range-receipts.md).
