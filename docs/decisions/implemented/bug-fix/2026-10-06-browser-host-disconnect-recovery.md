# Decision Record: Exception-safe Browser Host recovery

Status: implemented

## Problem

Browser Host page errors permit an empty description, while structured page errors require nonempty text. Promoting native text directly into a descriptor can make later state publication and persistence fail. A synchronous observer exception during broker teardown can retain the old registered connection and reject the Desktop's replacement Host indefinitely.

## Decision

The Browser Session normalizes native error text when it enters structured state: redact sensitive values, bound its length, trim whitespace and provide a fixed description when no text remains. Protocol v5 and persisted descriptor validation stay strict.

Broker detach clears the registered connection before teardown, rejects pending requests, releases old page resources and then publishes recovery notifications. Cleanup runs immediately even during synchronous reentrancy; only the captured old-generation observer fan-out is queued. Each lifecycle observer is isolated so one failure cannot block cleanup or another observer. Lifecycle fan-out is serialized: synchronous replacement registration cannot interleave ready notifications with the old Host's restarting notifications. Failed registration acknowledgements release their connection and drain queued teardown before propagating the failure. Browser event publication validates before dispatch and isolates subscribers while preserving sequence and replay history for valid events.

Observer and asynchronous error-state persistence failures log their fixed boundary, error classification and bounded schema issue codes/known field paths or allowlisted filesystem codes. They never log the original exception message, stack, arbitrary object keys or private paths.

Tests cover throwing page, owner and activity observers, synchronous reentrant replacement, same-page replacement with different temporary identities, failed handshake cleanup, temporary identity cleanup, stale socket detach, error text limits and persistence. Failure injection verifies safe diagnostics and recovery after a rejected save. A real Server WebSocket test combines Session and HostPage, verifying replacement registration, explicit resume with stable page/profile identity and no replay of an uncertain command.

## Alternatives considered

**Only normalize Electron's error description.** The backend owns structured descriptors and must enforce their requirements regardless of the native producer; a Desktop-only correction would leave other legal Host messages able to corrupt state.

**Relax the nonempty descriptor schema.** Empty structured errors give neither users nor agents a usable failure reason and do not address teardown exceptions.

**Only clear the broker connection in a finalizer.** That permits another Host to register but can still abandon remaining page resources and notifications when an observer throws.

**Restart the active backend or accept duplicate Hosts.** Restarting interrupts unrelated tasks and treating duplicate registration as recovery weakens the single authenticated Host invariant. Neither repairs the cleanup owner.

## Consequences

Observer failures remain visible through bounded safe diagnostics but cannot control Host availability. Invalid event payloads still fail validation; subscriber isolation is not schema relaxation. Resource cleanup precedes notification, so observers see the old Host's pages as unavailable. Recovery retains persistent identity partitions and descriptors, not JavaScript heaps or uncertain side effects. The change does not introduce automatic command replay, another browser engine or a persisted-state migration.
