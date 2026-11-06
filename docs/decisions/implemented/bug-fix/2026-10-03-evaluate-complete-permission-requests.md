# Decision Record: Evaluate complete permission requests before approval

Status: implemented

## Problem

Permission evaluation returned when the first target required confirmation. A later denied target was therefore never evaluated, making the result depend on target order. Mandatory confirmation on an otherwise allowed target could take the same early return.

## Decision

Evaluate all target rules before creating a pending request. Reject the request if any target is denied. Otherwise, create at most one approval for the complete target list when a target requires confirmation. Preserve rule resolution, control profiles, reply behavior and cancellation.

## Alternatives considered

**Reorder targets to put expected denials first.** Callers cannot know the complete effective rule set and ordering must not determine authorization.

**Create one approval per target.** This changes the public request contract and permits partial settlement of one operation.

## Consequences

Denied requests produce no pending approval event. Synthetic regressions cover both target orders, mandatory confirmation, persisted denials, multi-target approval and cancellation. Existing all-allow and profile tests continue to define their behavior. No API, configuration or persistence format changes are required.
