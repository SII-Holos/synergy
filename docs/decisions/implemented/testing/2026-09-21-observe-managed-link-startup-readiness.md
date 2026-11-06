# Decision Record: Observe managed Link startup readiness

Status: implemented

## Problem

The managed Link test assumed startup completed after a fixed 200 ms sleep. Coverage instrumentation and filesystem contention can leave the service legitimately starting at that point. A failed assertion also skipped shutdown, leaving the test-owned service alive.

## Decision

Wait for the observable running state within a bounded readiness window, propagate startup failures, and stop and drain the test-owned runtime in a finally block. Preserve every authentication, ownership, reconnect and startup timestamp assertion. The existing package test deadline bounds the complete test, including shutdown; product timing and runtime behavior are unchanged.

## Alternatives considered

**Retry until a faster runner passes.** This leaves the known scheduling assumption in the test and can fail unrelated changes again.

**Increase the fixed sleep.** This delays fast runs while retaining the same unobserved readiness assumption.

## Consequences

Fast startup no longer waits out an arbitrary delay. Slow or failed startup remains observable and bounded, and assertion failures still clean up the isolated service. This is a correctness test, not a startup latency benchmark.
