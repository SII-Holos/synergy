# Decision Record: Organization machine registration and connection fencing

Status: implemented

## Problem

An organization needs to identify member Runtime machines without turning a human login or a one-time registration ticket into a persistent machine credential. Reconnects, service restarts and revocation must not leave two authenticated sockets able to publish as the same current connection.

## Decision

Registration binds the authenticated account and device to an Ed25519 public key. The organization stores ticket digests and immutable activation receipts, while the machine retains its private key. Strict, purpose-bound signed proofs bind registration to the deployment and ticket, and bind connections to the complete versioned handshake. The bridge requires the next durable connection epoch, verifies current account and registration state, and carries socket liveness through the SQL commit guard.

Each independent service owns its socket registry and enters its Runtime context for asynchronous socket work. A replacement fences the old socket; durable revocation closes the corresponding live connection. Restart preserves epochs but reconstructs no active sockets. Bounded frames and windows prevent the transport from becoming an unbounded buffer. Heartbeat expiry changes availability without changing Session ownership.

The member adapter owns the outbound verified-TLS socket and a monotonic local acknowledgment checkpoint. It signs only its persisted registration identity and currently implemented capabilities, persists the accepted epoch before reporting connected, and can reconcile a higher authenticated server epoch after an acknowledgment is lost. Reconciliation retries once and never lowers local state to satisfy an older service snapshot. Heartbeats bind both epoch and sequence. Connection cancellation aborts checkpoint lock admission, while close drains pending work. Received protocol errors retain their structured meaning even when the service immediately closes the socket.

## Alternatives considered

**Reuse the human browser cookie or registration ticket.** Browser login and machine identity have different lifetimes and scopes. A persistent bearer registration ticket would also lack proof that the connecting machine owns its registered key.

**Use an in-memory connection generation.** It would reset after service restart and permit old connection proofs to establish the same generation again. Durable epochs plus deployment identity preserve the replay boundary.

**Use heartbeat expiry as authority to take over work.** Silence cannot establish that the old machine stopped executing. Availability and execution ownership therefore remain separate facts.

**Reset the client checkpoint after any stale-epoch error.** A restored older service snapshot could then cause a previously used epoch to be signed again. Higher-epoch reconciliation and lower-epoch refusal preserve evidence until explicit recovery establishes a new deployment or binding.

## Consequences

Machine registration and presence work without loading Agent execution or exposing Runtime routes to organization members. Clients must retain their key and use a new signed epoch after a disconnect. Transport authentication does not authorize a Session command, restore a revoked registration or prove that a disconnected execution owner surrendered its work. Those operations require their own durable facts and authorization.

The client uses [Bun's native WebSocket TLS API](https://bun.sh/docs/runtime/http/websockets#connect-to-a-websocket-server). Real WSS fixtures cover service revocation, acknowledgment loss, corrupted or regressed checkpoints, invalid frames, heartbeat loss and cancellation while another owner holds the checkpoint lock.
