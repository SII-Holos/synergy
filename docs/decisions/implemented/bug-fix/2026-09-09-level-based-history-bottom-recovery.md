# Decision Record: Level-based bounded-window bottom recovery trigger

Status: implemented

## Problem

Recovery from a bounded history window that no longer reaches the true latest messages — a tail gap after a cap-evicting prepend, or unseen arrivals parked into `pendingLatestIds` — was wired to a single `scrolledUp` falling edge: the page watched for the moment the user returned to the bottom and only then evaluated the recovery predicate. That coupling leaks three failure modes in a running session. A history load still in flight when the user reaches the bottom consumes the edge while the predicate is false, and when the load finishes the edge is gone, so the tail stays missing until a manual reload. Streamed arrivals that park into a history window while the user is already parked at the local bottom never produce an edge at all, leaving new messages invisible indefinitely. Both produce the same symptom: an active session's history loses a block and only a forced refresh restores it.

## Decision

The session page no longer triggers bottom recovery from a scroll edge. `createBottomRecoveryTrigger` evaluates the full recovery predicate — not scrolled up, history mode, a tail gap or pending arrivals present, no history load in flight — as a level, and fires the existing return-to-latest path once per gap episode. Each session starts disarmed: engagement — starting a history load, or scrolling up after the page has observed a not-scrolled-up evaluation — arms the trigger, so navigating in-app onto a retained history window (even from a scrolled-up session whose scrolled-up reset lands after the route change) never discards the stored view. Firing is latched with hysteresis: a fire stays consumed until the predicate is observed false again, and arm/latch updates freeze while a recovery request runs, so the request's own `historyLoading` flicker can neither re-arm nor re-fire it. A settled failure therefore never retries on its own; only a fresh gap transition, a resolved window, or a session change re-arms the trigger. The pure predicate `shouldRecoverToLatest` is unchanged, and the recover callback returns the request promise so the in-flight guard spans the actual return-to-latest load.

## Alternatives considered

**Keep the scroll edge and patch each leak.** Re-firing the edge when a load finishes and adding a second edge for pending arrivals under the cursor re-encodes level semantics as a growing set of special cases; the level expression states the intent directly.

**Retry a failed recovery on a timer.** A settled failure means the server still reports the same gap state; self-retrying would hammer the message page without new information and, with the guard cleared early, could loop unboundedly during an outage. A later due transition or the user's own action re-arms the trigger.

**Suppress only the initial evaluation after mount.** A level trigger keyed on a mounted-once flag still discards a retained history view when the component survives an in-app navigation and the next session arrives already gapped; per-session arming makes the suppression property (a fresh view is never auto-replaced) hold per session rather than per mount.

**Repair inside the sync layer when a load finishes.** The gap signals are sync-owned, but whether the user is at the bottom is not; swapping the visible window underneath a scrolling user belongs to the same presentation contract as the return-to-latest path itself.

## Consequences

Running sessions self-heal: a history load finishing under the cursor or new arrivals parking into an engaged history window converge to the latest view without user action. Opening or navigating onto a retained history session never auto-fetches over its stored view; the explicit "Return to latest" button and engagement remain the user's entry points there. A failed recovery costs at most one extra page request per gap episode. Regression coverage executes the trigger through the client Solid build (bun resolves `solid-js` to its server build, where render effects do not run) and covers the regression sequence, engagement arming, the disengaged-session guard, retained-view navigation (including the scrolled-up-carryover case), the scrolled-up guard, the latest-mode rejection, and in-flight freeze with no-self-retry semantics.
