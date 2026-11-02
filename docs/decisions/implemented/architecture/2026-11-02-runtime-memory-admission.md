# Decision Record: Runtime memory admission

Status: implemented

## Problem

GC watermarks describe one process and cannot determine how many delegated tasks a machine can safely run. Independent Cortex clamps, worker sizing formulas and worker termination defaults disagree about capacity. Delayed allocation can oversubscribe a healthy snapshot before the next observation, while exhausted queues must recover without a task completion.

## Decision

Harness owns a Runtime-scoped resource sampler and one atomic ledger of future allocation commitments. Local Runtime supplies native physical, cgroup, commit and Job observations through a typed host port. Facts carry freshness and coverage. Every applicable hard domain constrains headroom; Linux memory.high contributes pressure rather than a hard capacity. Native observations and independent timers wake admission without depending on optional telemetry.

Reservations cover future allocations only. A stage checkpoint reduces a commitment after a newer observation; release is idempotent and belongs to the operation that has actually stopped. Root owners rotate fairly. Execution ceilings are separate named resources in the same admission operation. Pressure suspends new allocations and permits measured recovery without terminating active leases. Permanent rejection requires a proven minimum above hard capacity; estimates alone do not establish impossibility.

Cortex retains one configured global ceiling and rotates root-session owners. Background launch returns a durable task handle before admission. AgentTurn owns model admission for both executors; Worker dispatch preserves admitted order, while the in-process executor owns readers without a second queue. Worker ceilings derive from explicit configuration or CPU availability. Default RSS and heap termination watermarks are absent; explicitly configured values retain their meaning. History hydration, prompt projection, attachment preparation and native process startup acquire allocation commitments before starting their work. Idle prewarming yields under pressure.

## Alternatives considered

**Machine-specific GC constants.** Changing thresholds for one RAM size preserves the incorrect coupling between per-process GC behavior and global capacity.

**Two scheduling controllers with a compatibility projection.** Independent limits would continue to disagree and make cancellation, wakeup and user-visible reasons ambiguous. Public consumers move with the owner instead.

**Memory.high as a hard capacity.** The kernel defines high as a throttling boundary and max as a hard limit. The adapter preserves that distinction and observes every visible ancestor's remaining capacity. See the [kernel documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory).

## Consequences

Memory admission is predictive, not an OS memory guarantee. Shared-process attribution and unknown native commands remain uncertain. Native pressure can defer new work indefinitely while preserving cancellation and existing explicit deadlines. OS measurements require platform tests; missing essential measurements are visible and block heavy admission. Runtime snapshots and commitments are transient and require no stored-data migration.
