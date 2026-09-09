# Decision Record: Level-based bounded-window bottom recovery trigger

Status: implemented

## Problem

Recovery from a bounded history window that no longer reaches the true latest messages — a tail gap after a cap-evicting prepend, or unseen arrivals parked into `pendingLatestIds` — was wired to a single `scrolledUp` falling edge: the page watched for the moment the user returned to the bottom and only then evaluated the recovery predicate. That coupling leaks three failure modes in a running session. A history load still in flight when the user reaches the bottom consumes the edge while the predicate is false, and when the load finishes the edge is gone, so the tail stays missing until a manual reload. Streamed arrivals that park into a history window while the user is already parked at the local bottom never produce an edge at all, leaving new messages invisible indefinitely. Both produce the same symptom: an active session's history loses a block and only a forced refresh restores it.

## Decision

The session page no longer triggers bottom recovery from a scroll edge. `createBottomRecoveryTrigger` evaluates the full recovery predicate — not scrolled up, history mode, a tail gap or pending arrivals present, no history load in flight — as a level, and fires the existing return-to-latest path once per false-to-true transition. An in-flight guard suppresses overlapping transitions while a recovery runs, and a settled attempt does not retry on its own; only a fresh due transition re-arms the trigger. The pure predicate `shouldRecoverToLatest` is unchanged.

## Alternatives considered

**Keep the scroll edge and patch each leak.** Re-firing the edge when a load finishes and adding a second edge for pending arrivals under the cursor re-encodes level semantics as a growing set of special cases; the level expression states the intent directly.

**Retry a failed recovery on a timer.** A settled failure means the server still reports the same gap state; self-retrying would hammer the message page without new information. A later due transition or the user's own action re-arms the trigger.

**Repair inside the sync layer when a load finishes.** The gap signals are sync-owned, but whether the user is at the bottom is not; swapping the visible window underneath a scrolling user belongs to the same presentation contract as the return-to-latest path itself.

## Consequences

Running sessions self-heal: a history load finishing under the cursor or new arrivals parking into an attended history window now converge to the latest view without user action. The initial evaluation never fires, so mounting a page whose metadata already reports a gap does not auto-fetch on open. Regression coverage executes the trigger through the client Solid build (bun resolves `solid-js` to its server build, where render effects do not run) and covers the regression sequence, the scrolled-up guard, the latest-mode rejection, initial-evaluation suppression, and in-flight/no-self-retry semantics.
