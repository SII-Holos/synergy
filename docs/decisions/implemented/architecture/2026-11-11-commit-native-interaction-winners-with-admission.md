# Decision Record: Commit native interaction winners with admission

Status: implemented

## Problem

An in-memory pending request does not prove who won a concurrent reply after a restart or lost acknowledgement. Persisting an Always allow rule separately from its decision or outer command receipt can grant permission without attributable acceptance. Resolving a native promise before that outer commit can start work which the admission later rolls back.

## Decision

Keep PermissionNext and Question as the pending-request owners. Store immutable winner receipts under their native Session, with decision kind, request identity, actor, time and result. The native Storage writer serializes first-writer-wins decisions and the permission rejection cascade. Existing local reply methods delegate to the same owner operations.

Always allow rules, the winner receipt and a caller's command receipt join one Storage transaction. Rule updates rely on that writer instead of taking a separate in-memory lock beneath SQL admission. Session rules, promise settlement and lifecycle events publish only after the outer commit. A synchronous final guard rejects a transaction when a selected request was cancelled during its awaited writes. A failed write or outer rollback cannot grant a cached rule or remove the pending request.

Late replies return the retained winner or an expired result. Restart does not reconstruct pending promises or approve a new request from an older receipt. Permission asks reject a previously resolved explicit identity. Session-owned receipts move with canonical history; imported decisions do not install Runtime rules. Always allow retains the existing Runtime-wide rules owner and does not widen resource grants or hard execution constraints.

Each unresolved native request can retain one tentative in-memory settlement alongside its exact candidate receipt. It cannot authorize work. If SQL committed but its acknowledgement was lost, a later transaction must read that identical canonical receipt before settling the original caller and invalidating a stale Runtime rule cache. Private question values remain only in that pending settlement; a retry cannot replace them with another actor's values. A missing receipt allows a fresh first-writer attempt, while a restart retains no pending settlement to replay.

Question stores redacted private answers and emits redacted lifecycle evidence. Only its original native caller receives the original submitted values. Organization transport must supply verified actor and binding evidence; these native operations do not own account roles or authorize collaboration.

## Alternatives considered

**Decide only in the collaboration service.** A network acknowledgement cannot atomically commit a native rule or settle the executing promise.

**Create a second pending-request store.** Duplicating PermissionNext or Question introduces competing lifecycles and cancellation authorities.

**Resolve first and compensate after failure.** Execution and persisted rules cannot be reliably undone after the caller observes acceptance.

## Consequences

Focused real-Storage tests cover concurrent winners, attribution, receipt-write failure, outer rollback, rejection cascades, restart, private-answer redaction and unchanged native cancellation. Organization command forwarding, pending projections and interactive UI are separate integrations; these owner changes alone do not complete the collaboration flow.
