# Decision Record: Settle conversation recovery motion at its existing owners

Status: implemented

## Problem

Preventing new navigation animations does not stop a disclosure or follow animation already running when its view leaves or recovery begins. A retained transcript can therefore return with completed process content still fading out. Restoring an inner process offset without its following intent also lets delayed body growth move completed history away from the latest action. Connection and Scope recovery can invalidate an earlier hydration result without replacing the mounted transcript.

## Decision

Keep visibility admission latched and revoke the existing layout-hydration interval on inactivity, disconnection, pending Scope recovery or renewed initial positioning. A reversible hydration notification reaches the existing outer auto-scroll owner. That owner reacts to removal or replacement of its animation target and settles the current animation immediately, without resetting reading or following state.

Cancelling only visual work preserves canonical viewport measurements used to distinguish native bottom clamping from new growth. Full motion reset remains with viewport rebinding, inactivity and disposal. Clearing that baseline whenever animation eligibility changes would animate an already-applied layout correction again.

Both inner and outer follow controllers revoke their own visual animation. Revoking the parent's hydration permission cannot cancel a separately owned inner Animation; the process viewport observes its composed readiness directly while retaining its saved following choice and geometry.

Shared disclosure bindings compose the existing ViewActivity context with their caller's animation permission. Revocation settles queued and running work at the requested visible state, including exit cleanup. Resize observers disconnect during inactivity and resume from current geometry; restoring permission alone cannot replay an entrance or exit. Explicit foreground disclosure still uses the caller's ordinary motion policy.

ProcessViewport restores following from its existing saved position state instead of treating every remount as a new non-explicit follow. Completed and running groups therefore preserve the same semantic choice through late body hydration. Saved reading anchors and subsequent native reading input remain authoritative. No new cache, timeout, retention budget or persistence format is added.

Foreground arrival receipts require the admitted transcript and recovered connection/positioning baseline, not completion of every mounted body. The existing live/replay/discovery source classification rejects historical content; a genuinely new foreground Part can still enter while older bodies settle. Automatic follow and collection remain independently gated by hydration. This refines [retained conversation readiness](2026-10-13-retained-conversation-readiness.md) without replacing its visibility, request or receipt owners. Current invariants live in [Frontend data sync](../../../architecture/frontend-data-sync.md#conversation-navigation-presentation).

## Alternatives considered

**Add per-component return flags or another restoration manager.** These duplicate ViewActivity, hydration and viewport state while leaving other disclosure consumers inconsistent. The shared binding and current scroll owners already have the required cancellation and semantic state.

**Hide warm content, wait for all history, or extend settling timers.** None establishes that a particular mounted body or measurement has completed. Each either hides accepted content or expands the delay without fixing animation ownership.

**Gate all Part receipts on body hydration.** Production browser acceptance rejects this: a new live Part immediately after a warm switch loses its original entrance. Transport provenance and recovered baseline determine arrival eligibility; historical layout settlement determines automatic movement eligibility.

**Restore only the cached offset, or force every reopened process to the bottom.** An offset cannot preserve following through later growth, while unconditional bottom placement destroys saved reading intent. Restoring the existing following choice preserves both modes.

## Consequences

Returning and reconnecting settle historical corrections statically without replacing the transcript, and existing live and manual interactions retain their motion. The production change remains in shared disclosure, outer auto-scroll, inner ProcessViewport and the existing SessionConversation hydration wiring; it adds no transport reads or subscriptions.

Regression tests distinguish queued preparation, running animation, stale completion, hidden resize, target replacement, connection/Scope/positioning recovery, completed/running remounts and user cancellation. Browser tests sample interrupted collection from the first visible frame. A pending-prose continuity test pauses a real exit animation at its midpoint and verifies both retained geometry and eventual release, replacing a fixed-frame timing assumption. The [production browser suite](../../../../test/plugin-ui5/messages-browser.test.ts) retains independent body/execution release order and genuine live arrival as counterexamples to blanket suppression. The [frontend verification guidance](../../../../.synergy/skill/develop-frontend/references/conversation.md#message-process-and-execution-details) owns the executable review procedure.
