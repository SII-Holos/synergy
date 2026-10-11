# Decision Record: Revoke Host stream admission and bound transfer expansion

Status: implemented

## Problem

Paired request authentication proves a body at one instant, but a response stream or pending WebSocket can outlive revocation, gateway shutdown or plugin generation replacement. Reading anonymous uploads before proof admission also permits resource retention before authorization. A small transfer ZIP can refer to the same bytes many times and expand beyond its package limit during destination materialization.

## Decision

Harness registers a pairing-UUID admission lease before checking gateway and peer authority. Revocation, pairing replacement and owner shutdown invalidate all already registered leases; invalid leases never resume after gateway reactivation. Server retains that lease through HTTP body completion/cancellation and pending/open WebSocket lifetime, aborts upstream work on withdrawal and refuses business open/message callbacks after withdrawal. Approved plugin generation replacement withdraws gateway authority without deleting durable pairing records; a rejected candidate leaves the approved generation unchanged.

Connection-management Host callbacks require the active, ready runtime generation. Host dispatch and configuration persistence/activation recheck that authority across asynchronous waits. Final-Scope withdrawal retires the runtime before disabling the gateway, and approved reload activates the candidate before withdrawal, preventing draining or queued old callbacks from re-enabling the owner.

Gateway API proof structure, active owner, peer and timestamp are checked before body consumption. Final Ed25519 body verification and persisted nonce admission remain mandatory before dispatch. API and pairing body intake share bounded reader count, aggregate reserved byte capacity and a finite reading deadline. Cancellation releases the reader and capacity rather than only racing a rejected promise.

Transfer archive validation charges every destination artifact reference and every Workspace chunk occurrence against expanded byte and total object/reference budgets. Writing and opening an archive use the same accounting before the prepared phase, receiving reservation or materialization. Unique ZIP-entry bytes cannot substitute for destination consumption.

## Alternatives considered

**Watch only after response headers or WebSocket open.** This leaves a pending admission gap and cannot revoke already returned HTTP/SSE bodies.

**Recheck the peer once after authorization.** A detached open event or response reader remains vulnerable after that check, and disable/reactivate can accidentally admit work carrying old authority.

**Keep only per-request body and unique ZIP-entry limits.** Concurrent unauthenticated readers and repeated references can exceed aggregate memory or destination disk limits while every individual entry remains within its limit.

## Consequences

Revocation terminates both pending and active transports without changing instance-level pairing scope or Session permission enforcement. The caller must establish a fresh admission after a generation change. Very large repeated-content transfers can be rejected even when their ZIP has few unique bytes. Focused regressions cover real dual-Host HTTP/WebSocket behavior, detached open events, Scope/generation lifecycle, cancelled and saturated intake, replay, and rejection of repeated archive consumption before reservation. Platform and physical cross-network acceptance remain separate from these isolated fixtures.
