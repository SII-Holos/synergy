# Decision Record: Own member bridge reconnection through resident services

Status: implemented

## Problem

A member process can expose its local HTTP service while its machine bridge has no resident owner. Manual connection handles do not provide reconnect after transient loss, and waiting for a remote service during startup would prevent reading local history offline. Automatically reconnecting every closed socket would also let replaced processes repeatedly fence each other.

## Decision

The explicit member Runtime composition starts its outbound bridge through the existing component resident lifecycle. It keeps one connection attempt or reconnect delay at a time. Local readiness does not await the organization service. One-shot opening and component discovery remain inert.

Transient transport loss and retryable availability errors use exponential backoff with equal jitter, beginning at one second and capped at thirty seconds. A connection lasting its negotiated offline interval resets the backoff. Replacement, revocation, protocol errors and local identity failures terminate automatic reconnect, preserving structured errors when available. Unknown local failures become a redacted terminal error.

The existing connection owner validates identity, persists monotonically increasing epochs and drains checkpoint writes. Runtime close cancels its attempt or delay and awaits that owner before closing storage. Supervisor-provided certificate authority input applies to both enrollment and WSS. The bridge continues to declare only its implemented capability; neither connectivity nor cached enrollment admits Session work.

## Alternatives considered

**Await organization connectivity before local readiness.** This would make local history unavailable during organization outages and couple two independently owned services' startup.

**Reconnect every termination.** This would turn explicit revocation and connection replacement into a retry loop and could make two machine processes compete for the same registration.

**Run another process-level connection supervisor.** Component services already provide failed-open cleanup and shutdown ordering for each Runtime, including multiple embedded instances. A separate owner would duplicate those guarantees.

## Consequences

Offline member HTTP remains usable, and temporary outages recover without starting another execution scheduler. Terminal failures require explicit recovery or a later process restart and are recorded without credentials or raw remote payloads. Real WSS tests cover transient loss, replacement, revocation and terminal protocol errors; Runtime integration holds a checkpoint lock through readiness and close, and the actual CLI verifies connection epochs across restart.
