# Decision Record: Converge dropped streaming part checkpoints and stale text snapshots

Status: implemented

## Problem

Two independent frontend sync defects made streaming replies visibly lose already-rendered segments until a manual refresh:

1. **Stale snapshot overwrites accumulated streaming text.** The event queue merges hidden-page `message.part.delta` frames into a pending delta that flushes _before_ older queued `message.part.updated` checkpoints, and the server's part write-buffer can flush a checkpoint snapshot that lags deltas already broadcast. In both cases applying the checkpoint verbatim shrinks the locally accumulated text of a live text/reasoning part — the rendered segment visibly loses content for up to a checkpoint interval, or permanently when the stream ended in between. Captured live: a reasoning part regressed 5437 → 4665 chars while its message streamed.
2. **Terminal checkpoints for messages outside the loaded window drop with no convergence path.** `message.part.updated` / `message.part.removed` handlers drop the event when its parent message is not in the loaded window (the part bucket must not be created for a message the window does not know about), and mark the message as requiring a newer snapshot via `SessionPartSnapshotFreshness`. That requirement is only consumed by an in-flight or next message-page load. While the user stays on the session — the exact case where the window is loaded but the message is not yet in it, e.g. an inbox materialization racing the window — nothing re-fetches, so the part stays missing until a manual refresh. Captured live: a materialized durable task's text checkpoint dropped with `hasWindow=true windowMessages=56` and never recovered.
3. **Sidebar prefetch applied message pages without the per-message part-snapshot gate.** The foreground loader captures a part-snapshot request and decides per message to apply, preserve, or retry; the background prefetch in `layout/index.tsx` accepted a resource-level token only and overwrote live part buckets unconditionally — the same stale-snapshot overwrite as (1) reachable through a different path.

## Decision

- Text/reasoning checkpoint application now merges monotonically (`mergeTextCheckpoint` in `apps/web/src/context/part-checkpoint-merge.ts`): a checkpoint whose text is a strict prefix of the accumulated text is an older snapshot, so the accumulated text is kept and only the checkpoint's metadata converges. Shorter diverging text (a genuine server rewrite) and all longer checkpoints apply verbatim.
- Dropped checkpoints/removals for a _loaded window_ now schedule one debounced repair reload per session (`createPartRepairScheduler`, 2 s debounce, 3 attempts per 60 s window). The reload reuses the compaction message loader — renamed `sessionWindowReload` — which already carries the full freshness gate stack (resource token, per-message part snapshots, supersede retries), so a repair can never clobber newer streaming state. `session.compacted` calls the same entry point; scope release, bucket eviction, and disposal cancel pending repairs.
- Sidebar prefetch plans its apply through `planPrefetchApply` (`apps/web/src/context/layout/prefetch-apply.ts`): per-message `preserve` skips that part bucket, and any `retry` voids the opportunistic prefetch entirely, leaving convergence to the next foreground load.

## Alternatives considered

**Fix the event-queue flush ordering instead of guarding at apply time.** Reordering hidden-page delta emission after queued checkpoints fixes one delivery source, but the server write-buffer flush can still deliver a lagging checkpoint in-order; the prefix guard at the apply site closes both sources and states the invariant where it is enforced. Rejected as incomplete on its own.

**Re-fetch the part or message on every dropped checkpoint.** A direct per-event refetch violates the no-per-event-REST-refetch rule and re-opens the request-storm the freshness gates exist to prevent. The debounced, budget-bounded scheduler keeps at most one in-flight repair per session and stops after 3 attempts per minute.

**Apply dropped checkpoints into a detached bucket keyed by messageID.** The window's ordering metadata would not know where to render the message, and the next page load would need to reconcile the detached bucket — re-implementing the loader's part-snapshot decision with more state. The repair reload converges through the already-tested load path instead.

**Prefetch reuse of the foreground loader.** The prefetch queue intentionally runs at concurrency 1 in the background without load-state tracking; routing it through the foreground loader would surface loading states for sessions the user is not viewing. The plan-level gate gives the same protection with the prefetch queue intact.

## Consequences

A rendered streaming segment can no longer shrink from an older checkpoint: the prefix guard is O(n) on the shorter string per checkpoint (amortized negligible against the existing reconcile). Sessions whose window is loaded but missing a streamed message now converge within ~2 s at the cost of at most one extra message-page request per debounce window, bounded to 3 per minute — the same request shape the compaction path already makes. Prefetch responses captured before a streaming mutation may now be discarded (`retry`) where they previously corrupted state, trading occasional redundant prefetch work for correctness. Terminal checkpoints for sessions with _no_ loaded window still drop by design; those sessions cold-load on next view, unchanged.
