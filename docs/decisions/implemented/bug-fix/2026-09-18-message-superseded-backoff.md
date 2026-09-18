# Decision Record: Bounded backoff and auto-restart for superseded message snapshots

Status: implemented

## Problem

Switching to a session that is actively streaming could reject every latest-page apply. Each `message.updated` event advances the message-resource revision, and every authoritative part checkpoint for an out-of-window message allocated a fresh snapshot-required retry mark — arriving faster than the loader's two back-to-back fetches completed. The loader then surfaced the visible "Message snapshot was superseded while loading" error with a manual retry button, and for a first view with no prior snapshot that stranded a blank transcript behind it.

Three compounding factors: only two attempts with no pause between them (a worst case of two round trips tens of milliseconds apart), one retry mark per ignored checkpoint during streaming bursts, and no automatic recovery path for a snapshot-less failure.

## Decision

The shared session message loader and the per-message part snapshot freshness guard now absorb event bursts instead of failing on the first sustained stream:

- The loader performs up to four superseded attempts, pausing between attempts with a doubling backoff (100 ms, 200 ms, 400 ms) via an injected `wait` so tests stay synchronous.
- When supersession exhausts on a load with no previously successful snapshot, the loader restarts the whole attempt window once after one pause at the backoff cap before publishing the error. A load with a visible snapshot keeps the immediate error so live state is never flashed away.
- `SessionPartSnapshotFreshness` coalesces back-to-back snapshot-required marks for the same message when no capture happened in between; every in-flight request predates the original mark and already retries, so extra revisions only widened the superseded window. A capture in between re-arms the mark so that request still sees the newer checkpoint.

## Alternatives considered

- **Unbounded superseded retries** — rejected: a permanently hostile event stream would spin requests forever; the visible error with the retry button remains the correct terminal state after bounded patience.
- **A longer single window (for example eight attempts) without the restart** — rejected: the restart mirrors the existing reconnect-recovery shape (a completed window resets the failure counter) and covers bursts longer than the first window's pauses without stretching worst-case latency for every caller.
- **Buffering or debouncing checkpoint events before marking** — rejected: it would delay authoritative part application in the live store and risk losing a mark if a capture landed inside the batch; decision-time coalescing keeps the guard exact with no event queue.
- **Server-side fix** — rejected: tool parts are intentionally unsequenced streaming events whose convergence relies on periodic checkpoints, so the freshness guard belongs at the frontend apply boundary, not in the wire protocol.

## Consequences

Switching to a streaming session now loads once the burst settles — typically within the first or second attempt — and a sustained storm costs one extra attempt window before the visible error, which still preserves any previously successful snapshot. The mark map allocates one entry per message that received an out-of-window checkpoint, bounded by message-bucket eviction and Scope/session release, which clear it alongside the revision spaces.
