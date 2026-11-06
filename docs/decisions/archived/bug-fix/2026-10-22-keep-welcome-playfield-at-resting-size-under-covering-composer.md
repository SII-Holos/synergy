# Decision Record: Keep the welcome playfield at its resting size under a covering Composer

Status: implemented
Archived: 2026-10-26

## Problem

Enlarging the Composer shrank the new-task playfield instead of covering it. The welcome is a background, and a covering Composer is documented as an obscuring layer that suspends the game clock without clearing state, so a foreground change must not reflow it. Both ways of enlarging the Composer showed the defect: expanding the long editor, and dragging the resize handle to raise the card.

The field was sized by the foreground's layout budget. `createPromptDockHeight` reports the dock's measured height into `--prompt-height`, and `.session-empty-view[data-interactive]` consumes it as bottom padding. Because that element is `height: 100%` under a global `border-box`, an expanding Composer deducted its new height from the content box rather than adding to it. The whole chain below it — `.session-welcome-region`, `.welcome-stage`, `.welcome-game` and `.welcome-game-space` — is `height: 100%` or `flex: 1`, so the canvas element simply became shorter. `usePixelCanvas` then recomputed `Math.min(width / 720, height / 360)` and letterboxed the fixed 720×360 world into the smaller box (slingshot draws with `align: "end"`).

Two screenshots of the same window measured the orange structure across both states: width ratio 0.5980 and height ratio 0.5984, with the horizontal centre fixed at 582 → 583.5 px. Equal ratios on both axes identify uniform scaling, not clipping or reflow; an unchanged window width isolates the height term as the driver.

The cost was not only visual. Every dock height change re-ran the canvas effect, which reallocated the backing bitmap, cleared it and repainted the frame; the expand/collapse animation repeated that dozens of times.

## Decision

`WelcomeStage` pins its own resting height while the Composer covers it. A `ResizeObserver` samples `clientHeight` whenever the stage is not covered, and a `createEffect` writes that value to `root.style.minHeight` while it is, removing the property otherwise. Coverage is detected by the existing `.session-workbench-pane` `MutationObserver`, whose attribute filter now spans `data-expanded`, `data-resized` and `data-motion`; the same signal drives `gameActive()` and a `data-covered` attribute.

`min-height` rather than `height`, so the field still grows with the viewport and a window change while covered cannot leave it permanently wrong. Sampling rather than measuring on entry, because the mutation callback runs after the Composer has already enlarged and shrunk the box. Including `data-motion`, because collapsing removes `data-expanded` immediately while the Composer animates for another 240 ms; releasing the pin at that point would jump the field while the editor is still tall. `clientHeight` rather than `getBoundingClientRect().height`, because the entry animation's `translateY` offsets the rect without changing layout height.

The playfield keeps its resting geometry, reserves no space for itself, and `--prompt-height` keeps its existing meaning for the conversation bottom padding and the scroll-to-bottom button. While covered, `.welcome-stage[data-covered] .welcome-game-space` fades to 0.5 opacity over 240 ms, so the fragments left visible around the Composer card read as a recessive background rather than a clipped picture. The game status control is not faded, since it is a focusable control, and reduced motion removes the transition.

## Alternatives considered

**Latch `--prompt-height` in the session layer while covered.** It changes the public `PluginSessionLayoutService` contract and must plumb Composer expand and resize state into `pages/session.tsx` for a result the stage can reach on its own. It also only fixes the desktop padding path; the narrow layout sizes the dock in flow instead of overlaying it.

**Scale the canvas by width only and crop the sky.** It keeps the playfield from shrinking, but the ground line and slingshot leave the frame, `canvas.point()` maps pointers outside the visible art, and the field still changes size — the reported problem rather than the cause.

**Hide the playfield while covered.** It removes the discontinuity at the cost of the continuity that makes the field a background, and it is a larger behavioral change than the defect requires.

**Cap the expanded Composer height.** It changes Composer behavior, conflicts with `composerBodyLimits`'s available-height calculation, and contradicts allowing the editor to cover the field.

**Mask the fade to the Composer's outline.** Precise masking would have to track card radius, shadow and padding, coupling the welcome stylesheet to Composer geometry for a difference that is nearly invisible.

## Consequences

An enlarged Composer covers the playfield and pauses it; the field neither scales, moves nor repaints, so covering it costs no canvas work. What remains visible beside the card is the top of the scene, and the fade keeps it subordinate. Returning the Composer to its resting height restores the unpinned layout once the animation settles, and the field again follows the viewport.

The pin covers a Composer that has grown by expansion or by dragging. Other causes of a taller dock — attachments, pending queue entries, decision cards — still resize the field, because they are not Composer growth; extending the trigger to "available height below resting" would also freeze a cold mount that begins with a tall dock, so it needs its own stability criterion.

`data-covered` is a new state hook on the stage; consumers that need "the field is covered" should use it rather than re-deriving Composer attributes.

Regression coverage is two tests in `apps/web/test/components/session/welcome/stage.dom.test.tsx`: `expanding the composer covers the playfield without resizing, repainting or moving it` and `dragging the composer taller covers the playfield without resizing it`. Their fixture reproduces the production chain — the dock-height helper feeds `--prompt-height`, which `.session-empty-view[data-interactive]` consumes — and asserts identical `boundingBox()` and canvas bitmap dimensions across the transition, plus `data-covered` and paused state.

The stage's `min-height` is inline, so a layout that sets its own resting minimum must do so in CSS; the welcome already owns 410 px there.
