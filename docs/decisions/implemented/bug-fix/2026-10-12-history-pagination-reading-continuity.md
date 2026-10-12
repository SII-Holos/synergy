# Decision Record: History pagination reading continuity

Status: implemented

## Problem

Loading older messages can move an already visible message even when keyed measurements remain valid. Native scroll events and resize delivery can arrive in either order, and history-header removal changes the required offset. Replacing the saved reading anchor during this transition attaches later restoration to an incoming row. A separate inline return-to-latest action duplicates the floating control. The incident is documented in the [postmortem](../../../postmortem/0069-history-pagination-reading-anchor.md).

## Decision

The shared scroll owner records scroll extent with the accepted reading anchor. When a scroll event arrives after an extent change without pending native movement, it restores that anchor before classifying the event. An unchanged-offset receipt also retains the accepted owner. Resize delivery continues to acknowledge the restored offset and extent. Wheel, keyboard, pointer and touch movement retain their existing priority; returning to latest and replacing the viewport clear saved geometry.

The transcript header contains only the load-earlier action. The floating return-to-latest control handles both loaded content below the viewport and canonical pending or missing latest-tail state. History mode alone does not show it at an already complete bottom. Its existing callback loads the latest window before following it.

## Alternatives considered

**Restore once when the history request resolves.** Body loading and virtual measurement continue after the response, so a single final correction cannot preserve the intervening frames or later growth.

**Suppress every scroll receipt during pagination.** Native reading input must remain effective while content loads. Checking pending movement and measured extent keeps that distinction in the existing scroll owner.

**Keep the inline latest action.** It duplicates navigation and adds changing geometry above the transcript. Canonical window state lets the floating control cover unloaded latest content without the extra action.

## Consequences

The scroll owner reads scroll extent when capturing and accepting an anchor. Existing virtualizer compensation remains intact; the correction governs which reading intent survives its events. This supplements [keyed measurements](2026-10-12-keyed-conversation-measurements.md), which prevent invalid row sizes.

Browser regressions click the history control and check every frame through header retention or removal, narrow layouts and lazy body measurement. Shared hook tests cover scroll-before-resize ordering, repeated receipts and concurrent native input. Conversation integration tests verify a single keyboard-operable latest action even when the loaded window itself has no overflow.
