# Decision Record: Keep continuation authority out of task summaries

Status: implemented

## Problem

Cortex needs exact native root, repair-input and transfer-hold metadata to retain task identity across interruption. Exposing those private fields in general Session summaries would publish execution internals and potentially the original repair text.

## Decision

Keep optional continuation fields in the owning canonical Cortex Session contract. Distinguish pending initial input from exact repair input, and retain transfer holds as typed versioned metadata. The public task summary explicitly omits native root IDs, repair counters, pending inputs and transfer authority. None of these fields authorizes execution by itself.

This contract permits existing records without continuation metadata. Native freeze, staging, resumption and capability checks remain the responsibility of their execution owners; publishing this schema does not claim that a complete handoff has occurred.

## Alternatives considered

**Store another task authority table.** This would compete with canonical Session Cortex ownership.

**Expose the complete persisted Cortex object as a summary.** This would leak exact continuation inputs and private transfer state.

## Consequences

Generated native contracts describe optional persisted metadata while task summaries preserve their narrower privacy boundary. The public summary regression verifies both ordinary task visibility and exclusion of exact private input and transfer fields.
