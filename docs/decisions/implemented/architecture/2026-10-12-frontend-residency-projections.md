# Decision Record: Bounded frontend residency and demand-driven projections

Status: implemented

## Problem

Recreating session and resource presentations interrupts reading and editing. A transport carrying full execution summaries, repeated contexts and growing text checkpoints makes unrelated navigation pay for active tasks. Replay alone cannot detect every missed tool body change.

## Decision

Retain six session presentations and eight resource panels with captured owners, activity lifetimes and LRU eviction. Domain state remains authoritative; residency holds presentation state, not another synchronization store. Cache panel modules separately from instances and require an explicit pause contract for third-party instances. Keep first-open loading local to unavailable content. This supersedes the outgoing DOM copy and preparation barrier in [Session navigation presentation](../bug-fix/2026-10-10-session-navigation-presentation.md), preserving its new-task identity and transcript isolation invariants.

Negotiate `projection-v2` through capabilities. Runtime registers domain contributors on the Server-owned transport boundary. Leases govern detail computation and delivery. Omitted state events advance contiguous cursors; detail patches have independent revisions. Stream append identity/offsets avoid repeated whole-content hashing. Bounded transient HTTP checkpoints carry content exceeding the 64 KiB frame limit.

Validate message versions and Part page generations after replay, in batches of 100. Repair changed admitted ranges without refetching unchanged bodies or discarding historical reading windows. Drain the frontend event queue with both count and time budgets.

## Alternatives considered

**Retain every presentation.** This preserves interaction state but leaves resources, listeners and old owners unbounded. Shared LRU and content budgets make the lifecycle explicit.

**Hide the whole target until every body and measurement is ready.** This avoids intermediate geometry but interrupts warm navigation and couples readability to unrelated work. Local placeholders and retained anchors isolate that cost.

**Keep broadcasting full summaries and compress them.** Compression may reduce wire bytes while retaining serialization, decoding and reconciliation work. Subscription projection removes work that the current view does not consume.

**Trust successful replay as body validation.** Unsequenced or non-replayed tool mutations can remain missing. Version/generation manifests verify loaded data independently of replay.

## Consequences

Warm navigation can preserve DOM and reading state while inactive views release expensive leases. Transport work follows consumed changes; legacy connections keep a narrow compatibility path. Transient checkpoints add bounded Runtime memory, and subscription generations require precise cancellation and recovery fences. No persisted storage format changes. Behavioral browser, range recovery, append-work and lease tests guard these boundaries; device timing is recorded separately from deterministic CI work limits.
