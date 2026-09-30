# Decision Record: Deterministic benchmark deadline accounting tests

Status: implemented

## Problem

The nested lifecycle queue test used a 30-millisecond active-time bound while writing durable stage evidence synchronously. Filesystem and runner scheduling delays could violate that bound even when pausing and restoring both deadlines worked correctly.

## Decision

The [lifecycle test](../../../../benchmark/test/test_lifecycle.py) advances one controlled clock shared by the event loop and lifecycle duration measurements. It exercises the real asyncio timeout contexts and yields to timer callbacks while paused and after resuming. Both nested stages must retain exactly 60 seconds queued, 3 seconds active and 63 seconds elapsed. The separate real-time expiry and cancellation test remains unchanged.

The [benchmark development Skill](../../../../.synergy/skill/develop-benchmark/SKILL.md) records this distinction between deadline correctness and machine latency. Production clocks, stage persistence and deadline policy are unchanged.

## Alternatives considered

**Increase the wall-clock tolerance.** Rejected because another loaded runner can exceed it without violating the behavior under test.

**Remove the active-time assertion.** Rejected because the test must still prove that queued time is excluded from both nested stages.

## Consequences

The regression retains actual timeout scheduling and durable evidence while removing dependence on host speed. Real-time timeout and cancellation behavior remains covered independently.
