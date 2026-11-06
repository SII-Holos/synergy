# Decision Record: Bound progress publication independently of durable evidence

Status: implemented

## Problem

Transport blocks repeat attempt journal and Usage updates even when only byte counters advance. Unsequenced text frames interrupt cursor coalescing, and complete Session navigation projections still trigger redundant list requests. These independent multipliers increase storage, event and query work under concurrent Sessions.

## Decision

Every admitted transport block still commits its artifact manifest before delivery. The recorder publishes attempt and Usage progress on the first nonempty block of each channel, then on the next block after one second, after one MiB, or when final provider usage is available. Response metadata, body completion, cancellation, failure and interruption retain immediate publication. Recovery resolves the artifact identity against its durable manifest, including bytes committed after the last progress event. This changes publication cadence without changing stored formats or running historical conversion.

Cursor ranges remain bounded by 50 ms and 128 Scopes. An unsequenced frame does not participate in replay ordering and does not flush that Scope's pending range. A sequenced visible frame still receives its preceding cursor first; noncontiguous ranges and epoch changes remain distinct.

Complete navigation projections update known rows directly. Unknown rows, incomplete projections, membership, pinning, backward activity and unread aggregate changes still invalidate their lists. A refresh requested during an older list read remains pending until that read settles. Disposal cancels pending refresh timers.

The implementation uses TanStack Query's authoritative-response cache update principle in the existing Solid stores rather than adding another cache owner. Codex's rollout recorder provides a useful comparison for explicit persistence acknowledgments and terminal draining; Synergy retains its stronger per-block artifact publication requirement. See the implementation provenance in [navigation projection](../../../../apps/web/src/context/layout/nav.ts), [TanStack guidance](https://tanstack.com/query/latest/docs/framework/react/guides/updates-from-mutation-responses) and [Codex recorder](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs).

## Alternatives considered

**Delay artifact durability with progress.** Rejected because consumers could observe bytes that recovery cannot read. The artifact checkpoint remains a delivery barrier.

**Drop cursor frames or discard background Session events.** Rejected because replay ordering and recovery need complete contiguous sequence coverage. Coalescing preserves that coverage.

**Refresh every list after every metadata event.** Rejected because the complete server row already contains the replacement data. Structural and aggregate changes retain authoritative reads.

**Treat reduced write pressure as a memory leak fix.** Rejected because allocation pressure and retained memory have different causes. Neither these changes nor bounded fixture memory establish the cause of a separate long-running backend's heap growth.

## Consequences

Logical progress writes and associated event traffic depend on publication cadence instead of transport block count. Idle in-progress presentation may lag until another block or terminal event; durable byte recovery does not lag. Existing historical journals remain readable and retain their size. This work adds no dependency, migration, full-library scan or platform-specific CI fixture.

Focused tests cover durable intermediate bytes, recovery beyond a stale journal, final usage and terminal outcomes, interleaved cursor ordering, metadata-only navigation updates and a delayed list response. Real-data performance experiments remain outside CI; CI uses temporary storage, synthetic content and existing browser fixtures.
