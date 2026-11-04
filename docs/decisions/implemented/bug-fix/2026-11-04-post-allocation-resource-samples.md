# Decision Record: Resource release waits for post-allocation observation

Status: implemented

## Problem

Native resource sampling may already be in flight when an allocation finishes. Joining that observation and immediately releasing the allocation commitment can credit headroom measured before the allocation, admitting another request against unavailable memory.

## Decision

Allocation completion first drains an in-flight observation, then requests a new sample. Reservations, allocation wrappers and AgentTurn startup/disposal use this ordering before releasing or checkpointing the associated commitment. Ordinary sampling still coalesces concurrent requests; the admission ledger remains the single owner of resource decisions.

## Alternatives considered

**Reuse whichever sample finishes next.** Rejected because completion time cannot establish when the native measurement captured available memory.

**Serialize all native observations and allocations.** Rejected because allocations need not block independent work; retaining their existing commitment until a post-allocation observation is sufficient.

## Consequences

Completion may require one additional native sample. Commitments remain conservative during that wait. A controlled native-source regression holds the pre-allocation measurement across completion and verifies a waiting allocation cannot consume stale headroom. The [resource admission reference](../../../architecture/resource-admission.md) defines the ledger and pressure policy.
