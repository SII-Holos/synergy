# Decision Record: Revoke Host stream admission and bound transfer expansion

Status: implemented

## Problem

Paired request authentication proves a body at one instant, but a response stream or pending WebSocket can outlive revocation, gateway shutdown or plugin generation replacement. Reading anonymous uploads before proof admission also permits resource retention before authorization. A small transfer ZIP can refer to the same bytes many times and expand beyond its package limit during destination materialization.

## Decision

Harness registers a pairing-UUID admission lease before checking gateway and peer authority. Revocation, pairing replacement and owner shutdown invalidate all already registered leases; invalid leases never resume after gateway reactivation. Server retains that lease through HTTP body completion/cancellation and pending/open WebSocket lifetime, aborts upstream work on withdrawal and refuses business open/message callbacks after withdrawal. Approved plugin generation replacement withdraws gateway authority without deleting durable pairing records; a rejected candidate leaves the approved generation unchanged.

Admission disposal is single-settle and collection-identity checked, preventing a delayed old socket error/close sequence from removing a successor's revocation watcher. Native WebSocket upgrade success explicitly transfers ownership. Gateway responses without native upgrade retain ordinary HTTP response-body cleanup; the source proxy awaits the actual Hono helper and releases a lease on either a no-upgrade return or an asynchronous failure, because neither guarantees a socket lifecycle callback.

Connection-management Host callbacks require the active, ready runtime generation and a live invocation. Invitation, approval, receipt acceptance, revocation and configuration writes check authority before mutation and carry an optional synchronous commit guard through Storage and both SQL drivers. PostgreSQL runs that guard after its post-body ownership SQL await and SQLite after its body, immediately before issuing COMMIT. A thrown assertion rolls back staged records without compensating after commit. Nested Storage mutations add their guards to the enclosing write; retries collect them afresh, and guarded writes cannot join a read snapshot. Pair/finish also recheck after network responses, and queued approval rechecks after the pairing lock. Configuration activation rechecks after persistence. Final-Scope withdrawal retires the runtime before disabling the gateway, and approved reload activates the candidate before withdrawal, preventing draining or queued old callbacks from restoring authority.

Gateway API proof structure, active owner, peer and timestamp are checked before body consumption. Final Ed25519 body verification and persisted nonce admission remain mandatory before dispatch. API and pairing body intake share bounded reader count, aggregate reserved byte capacity and a finite reading deadline. Cancellation releases the reader and capacity rather than only racing a rejected promise.

Transfer archive validation charges every destination artifact reference and every Workspace chunk occurrence against expanded byte and total object/reference budgets. Writing and opening an archive use the same accounting before the prepared phase, receiving reservation or materialization. Unique ZIP-entry bytes cannot substitute for destination consumption.

## Alternatives considered

**Watch only after response headers or WebSocket open.** This leaves a pending admission gap and cannot revoke already returned HTTP/SSE bodies.

**Recheck the peer once after authorization.** A detached open event or response reader remains vulnerable after that check, and disable/reactivate can accidentally admit work carrying old authority.

**Keep only per-request body and unique ZIP-entry limits.** Concurrent unauthenticated readers and repeated references can exceed aggregate memory or destination disk limits while every individual entry remains within its limit.

**Check only when the business callback returns.** PostgreSQL still awaits ownership SQL on a separate connection before COMMIT; generation retirement or cancellation during that wait can invalidate the staged grant. The driver must own the final synchronous authority decision rather than requiring each caller to predict backend waits.

## Consequences

Revocation terminates both pending and active transports without changing instance-level pairing scope or Session permission enforcement. The caller must establish a fresh admission after a generation change. Very large repeated-content transfers can be rejected even when their ZIP has few unique bytes. Focused regressions cover real dual-Host HTTP/WebSocket behavior, detached open events, Scope/generation lifecycle, cancelled and saturated intake, replay, and rejection of repeated archive consumption before reservation. Platform and physical cross-network acceptance remain separate from these isolated fixtures.

Focused commit-fence evidence includes a real SQLite rollback and a narrow SQL transport fixture executing the real PostgreSQL driver's post-body ownership await with real staged records and RPC generation replacement/cancellation. At that precise barrier, the callback-end-only implementation failed both retired-authority cases while the current-generation control passed; the driver commit guard makes all three pass. Negative assertions preserve incoming/invitation records and prevent peers; nested guards remain effective after inner return, retries discard guards from aborted attempts, and receipt replay retains the outer guard without rerunning nested mutations. Existing rollback, receipt, snapshot and post-commit notification checks remain green. The documented local PostgreSQL URL was absent during this verification, so the real PostgreSQL ownership-response regression is registered but skipped; the transport fixture does not establish PostgreSQL 16–18 engine acceptance.

Source proxy native-upgrade regressions use the actual Hono helper and authenticated Server routes with real pairing/admission. Native false and throw outcomes failed the disposer assertion before the fix and pass afterward; three repeated failed attempts each dispose once and remain detached during subsequent revocation. The successful upgrade control retains its watcher until socket ownership settles. These deterministic adapter tests do not substitute for physical cross-network or platform acceptance.
