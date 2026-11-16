# Decision Record: Batch original shared history event reads

Status: implemented

## Problem

A shared message page chooses the version of each object at a fixed watermark, then reads each referenced immutable event separately. Ten readers replaying ten thousand messages issue one hundred thousand event point reads in addition to their required version lookups. A real capacity case can exhaust its unchanged whole-case budget during replay after native writes and synchronization have completed. Current projection copies cannot substitute for the historical lookup: even a valid older copy can disagree with the selected as-of version.

## Decision

Shared projection pages retain the original per-object version range and strict sequence decoder. After choosing those references inside the original read snapshot, one bounded record read loads their immutable events. The Record owner applies its existing per-key upgrade and schema decoder; missing values, duplicate keys and input positions remain intact. Single-object reads use the same algorithm. Window filtering, cursor/generation validation and authorization remain with their original owners.

The existing literal version-reference and object-index validators are reused at module scope. They depend only on fixed wire primitives; no Runtime-selected schema, canonical record, permission result or actor authority is cached. Existing storage batches retain their native read limit.

## Alternatives considered

**Trust a current projection as the historical head.** A structurally valid older projection can select an older immutable event while the canonical version index selects the newer event. The read path keeps its existing historical semantics instead of introducing that dependency.

**Add a new storage multi-range API or extend capacity deadlines.** The existing record batch reader removes the independent point-read overhead without a new storage ABI, persisted format or business-budget change.

## Consequences

A fifty-object page retains fifty version ranges and replaces up to fifty immutable record reads with one bounded batch. This is a storage work reduction, not a CPU percentage or capacity-pass guarantee. Malformed immutable data and references retain their original decoder failures, while missing events and index mismatches keep their existing window behavior. Fixed-watermark update/deletion/newborn windows, stale current copies, equal-time pagination and authorization remain regression controls. Full original capacity acceptance is still required. See the [shared transcript decision](../architecture/2026-11-11-project-authorized-shared-transcripts.md).
