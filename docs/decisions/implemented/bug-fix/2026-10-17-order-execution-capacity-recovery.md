# Decision Record: Order execution capacity recovery

Status: implemented

## Problem

A tool entering execution releases its tool slot while acquiring Cortex capacity, then reacquires its tool slot. Workspace wait recovery acquired the same capacities in the opposite order. Under simultaneous child admission, a returning tool could hold the tool slot while waiting for Cortex, while a new tool held Cortex and waited for the tool slot. The burst execution fixture stopped making progress despite idle model workers.

## Decision

Recover Cortex capacity before tool capacity regardless of context insertion order. This matches tool admission and removes the circular wait. Continue releasing both capacities during external waits, preserving cancellation and attempting recovery of each owner before propagating failures.

## Alternatives considered

**Raise or disable concurrency limits.** Additional slots only move the saturation point and weaken memory protection without removing the cycle.

**Serialize all child launches.** Paced submission avoids the observed trigger but constrains independent tasks and leaves other returning waits exposed.

**Introduce a second scheduler.** The existing owners already provide pause and resume contracts. A consistent acquisition order fixes the demonstrated cycle without replacing them.

## Consequences

Default limits, pressure adaptation, task identity and lifecycle remain unchanged. A returning task can wait for Cortex before reclaiming its tool slot. Regression coverage races a new tool with a returning external wait under one slot per resource, then verifies completion, bounded activity and queue drainage. Existing cancellation and Workspace binding suites remain required. Real simultaneous admission is measured separately from frontend event throughput in the [performance fixture](../../../../apps/web/test/performance/README.md).
