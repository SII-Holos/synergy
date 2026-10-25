# Decision Record: Keep automatic conversation growth unsmoothed

Status: implemented

## Problem

When the latest conversation was already at the bottom, each content resize caused `createAutoScroll` to call `createScrollMotion` with a `translateY` animation on the conversation motion node. Repeated stream growth restarted that animation before it settled, producing a visible vertical bounce even when `scrollTop` remained at the bottom.

## Decision

Automatic bottom maintenance performed from the resize observer uses an immediate scroll update and does not animate the conversation motion target. Explicit forced navigation may still request smooth motion, while ordinary reading-anchor restoration remains unchanged.

The regression contract belongs to `createAutoScroll`: a pinned viewport that grows by a small amount keeps the motion target unanimated. The browser diagnostic also records the production-shaped `translateY(14px)` failure and verifies that the target remains unanimated after the fix.

## Alternatives considered

**Keep restarting the smooth animation for every resize.** Rejected: streaming content can resize more frequently than the animation duration, so the painted content repeatedly moves away from and back toward its final position.

**Clamp `scrollTop` or add another edge-overscroll rule.** Rejected: the observed movement is a script-driven transform, not the native compositor edge effect; a clamp would also compete with virtual reading-anchor compensation.

**Remove all conversation motion.** Rejected: explicit smooth navigation is an independent interaction and does not need to lose its existing behavior.

## Consequences

Live growth at the latest edge is visually stable and remains pinned without restarting a transform animation. Viewport and content resize handling still performs the required immediate bottom update, and explicit smooth force-scroll remains available. The browser fixture verifies the user-visible motion boundary; final Desktop validation is still required for platform-specific compositor behavior.
