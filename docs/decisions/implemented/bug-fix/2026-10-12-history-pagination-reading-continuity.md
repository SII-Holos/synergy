# Decision Record: History pagination reading continuity

Status: implemented

## Problem

Loading older messages can move an already visible message even when keyed measurements remain valid. Native scroll events and resize delivery can arrive in either order, and history-header removal changes the required offset. Replacing the saved reading anchor during this transition attaches later restoration to an incoming row. A separate inline return-to-latest action duplicates the floating control. The incident is documented in the [postmortem](../../../postmortem/0069-history-pagination-reading-anchor.md).

## Decision

The shared scroll owner records scroll extent with the accepted reading anchor. When a scroll event arrives after an extent change without pending native movement, it restores that anchor before classifying the event. An unchanged-offset receipt also retains the accepted owner. Resize delivery acknowledges the restored offset but leaves changed extent pending until the scroll receipt or a new reading capture. This protects against compensation written after resize restoration as well as before it. Wheel, keyboard, pointer and touch movement retain their existing priority; returning to latest and replacing the viewport clear saved geometry.

Native movement priority lasts through the scrolling sequence, not only its first receipt. Each accepted movement updates the pending offset; the viewport's native `scrollend` releases it. This follows the [CSSOM scrolling completion contract described by MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollend_event): scrolling finishes after pending position updates and the gesture complete. A frame timeout cannot stand in for that event.

The inner process viewport follows the same lifetime. Each changed movement receipt cancels pending layout restoration before capturing the new reading point; the first receipt does not end its movement marker. Existing following, disclosure and disposal paths still release that marker independently.

Resize observation follows target membership incrementally. Capturing or replacing a reading owner during resize delivery must not unobserve and re-observe unchanged content or viewport ancestors: doing so restarts their initial notifications inside the same delivery cycle. Removed targets are released, new targets are observed, and the existing observer primitive owns final disconnection.

The transcript header contains only the load-earlier action. The floating return-to-latest control handles both loaded content below the viewport and canonical pending or missing latest-tail state. History mode alone does not show it at an already complete bottom. Its existing callback loads the latest window before following it.

## Alternatives considered

**Restore once when the history request resolves.** Body loading and virtual measurement continue after the response, so a single final correction cannot preserve the intervening frames or later growth.

**Suppress every scroll receipt during pagination.** Native reading input must remain effective while content loads. Checking pending movement and measured extent keeps that distinction in the existing scroll owner.

**Keep the inline latest action.** It duplicates navigation and adds changing geometry above the transcript. Canonical window state lets the floating control cover unloaded latest content without the extra action.

## Consequences

The scroll owner reads scroll extent when capturing and accepting an anchor. Existing virtualizer compensation remains intact; the correction governs which reading intent survives its events. This supplements [keyed measurements](2026-10-12-keyed-conversation-measurements.md), which prevent invalid row sizes.

Browser regressions click the history control and check every frame through header retention or removal, narrow layouts and lazy body measurement. Shared hook tests write compensation before and after resize delivery, paired with concurrent native input and repeated receipts. Conversation integration tests verify a single keyboard-operable latest action even when the loaded window itself has no overflow.

The hook matrix also keeps one gesture active across tail growth and a second movement, then requires later compensation to preserve reading after `scrollend`. A browser test sends a real PageDown, waits for its native completion, and checks paragraph geometry through subsequent resize and compensation. Platform-dependent scroll-event counts are not an acceptance measure.

Component regressions deliver two movements around a pending body layout in one Space or PageDown gesture, then require stable reading after the gesture ends. The existing real Space/body-growth integration retains its original movement assertion.

A real-browser regression rebinds content while detached reading is active, then reacquires its owner during resize delivery. It requires no window error, preserved reading intent and an unchanged paragraph position; callback counts alone cannot establish that the browser completed notification delivery.
