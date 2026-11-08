# Decision Record: Authorize online command attempts independently of Runtime acceptance

Status: implemented

## Problem

An online indicator or a signed permit cannot establish that the Runtime committed an input. A permission change can race authorization, a connection can end during storage work, and a delayed acknowledgment can arrive after a timeout or reconnection. Persisting input bodies as retry work would also turn private member commands into a service-side execution queue.

## Decision

The service's internal admission owner captures input and credentials before asynchronous digest work. In one organization transaction it resolves current Session access, derives the account actor and validated client kind, verifies the stored target and active registration, captures a capable live connection, signs a finite permit and writes logical identity, attempt, sequence and indexes. The driver commit guard checks the same connection and permit window. Storage retains only metadata and digests.

The owner represents admitted, dispatching, definitely unsent, unknown, accepted and rejected facts separately. Only the logical request whose attempt is unresolved reports an unknown outcome. Another request blocked before admission is definitely unsent. A current Runtime connection may reconcile an earlier valid authorization after project revocation, while new admission and human reads still check current access. An accepted effect is immutable and can be returned to an authorized reader without dispatching again.

Accepted results and issued skip receipts settle only their own pending sequence. Unknown attempts cannot be skipped without reconciliation. Every issued skip proof has a retained identity, independently of the latest proof, so a new connection cannot erase the evidence needed to accept an older committed skip. Timeout callbacks and old receipts cannot downgrade terminal evidence or clear a newer pending command.

## Alternatives considered

**Treating admission as acceptance.** This confuses two independent commits and can tell a user their input was received when the Runtime never saw it.

**Persisting input bodies for automatic resend.** This changes private-content ownership and permits replay after restart or authorization changes. Active forwarding must retain only its bounded in-memory payload.

**Keeping only the latest skip proof.** A Runtime can commit an earlier proof before the acknowledgment is lost. Replacing that proof would make a truthful result unverifiable after reconnect.

## Consequences

Tests use real service storage and authenticated WebSockets for capability and liveness checks, concurrent admission, SQL rollback, client attribution, restart, revocation ordering and reconciliation. Protocol receipt fixtures isolate the service's result-validation policy; Runtime Inbox effects have their own real-storage suite.

This is an internal authorization and metadata owner. It has no HTTP mutation or wire forwarding registration and does not activate execution or resource grants. An unresolved predecessor holds later admission until the transport owner reconciles it. Explicit forwarding, resource admission and lifecycle cleanup remain integrations of these records. The [organization architecture](../../../architecture/organization.md#service-command-admission) defines current ownership.
