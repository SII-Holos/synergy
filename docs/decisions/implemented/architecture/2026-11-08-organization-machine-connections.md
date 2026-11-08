# Decision Record: Organization machine registration and connection fencing

Status: implemented

## Problem

An organization needs to identify member Runtime machines without turning a human login or a one-time registration ticket into a persistent machine credential. Reconnects, service restarts and revocation must not leave two authenticated sockets able to publish as the same current connection.

## Decision

Registration binds the authenticated account and device to an Ed25519 public key. The organization stores ticket digests and immutable activation receipts, while the machine retains its private key. Strict, purpose-bound signed proofs bind registration to the deployment and ticket, and bind connections to the complete versioned handshake. The bridge requires the next durable connection epoch, verifies current account and registration state, and carries socket liveness through the SQL commit guard.

Each independent service owns its socket registry and enters its Runtime context for asynchronous socket work. A replacement fences the old socket; durable revocation closes the corresponding live connection. Restart preserves epochs but reconstructs no active sockets. Bounded frames and windows prevent the transport from becoming an unbounded buffer. Heartbeat expiry changes availability without changing Session ownership.

## Alternatives considered

**Reuse the human browser cookie or registration ticket.** Browser login and machine identity have different lifetimes and scopes. A persistent bearer registration ticket would also lack proof that the connecting machine owns its registered key.

**Use an in-memory connection generation.** It would reset after service restart and permit old connection proofs to establish the same generation again. Durable epochs plus deployment identity preserve the replay boundary.

**Use heartbeat expiry as authority to take over work.** Silence cannot establish that the old machine stopped executing. Availability and execution ownership therefore remain separate facts.

## Consequences

Machine registration and presence work without loading Agent execution or exposing Runtime routes to organization members. Clients must retain their key and use a new signed epoch after a disconnect. Transport authentication does not authorize a Session command, restore a revoked registration or prove that a disconnected execution owner surrendered its work. Those operations require their own durable facts and authorization.
