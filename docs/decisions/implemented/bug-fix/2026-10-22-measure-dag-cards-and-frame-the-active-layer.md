# Decision Record: Measure DAG cards and frame the active layer

Status: implemented

## Problem

The session progress DAG cut off its own content in two independent ways.

Card height was derived from character count: `estimateCardH` divided a fixed content width by a single `CHAR_W = 7.1` advance and multiplied by the line height. Card text is product copy that mixes CJK with Latin, and a CJK glyph advances roughly twice as far as a Latin one, so the estimate returned too few lines. The card then applied that height with `overflow: hidden` on the content, so the tail of a wrapped line disappeared without any scroll affordance. Measured on the real card box, a 53-character mixed string needed 60px of content but was given 42px, and a longer string needed 78px against 56px; the clamp at `MAX_CARD_H` capped the worst cases further.

Separately, auto-focus framed only the cards whose status was `running` (`fitToNodes(running)`), or the `focusNodeId` card alone. With the zoom capped at 1, a single 280px card was centred at 100% while its three parallel siblings sat outside a ~640px viewport. Six of eight cards were off screen, each showing a sliver at the edge, which reads as missing work rather than a panned viewport.

Both defects pointed at the same missing capability: the layout had no way to ask the rendered document how tall a card actually is.

## Decision

Layout computation moved to [dag-graph-layout](../../../../packages/ui/src/components/dag-graph-layout.ts), a pure module that takes an optional `CardHeight` callback. [dag-graph.tsx](../../../../packages/ui/src/components/dag-graph.tsx) measures the rendered cards: it sets `height: auto` on the card elements, reads `offsetHeight`, restores the previous heights, and stores the result keyed by card width. Measurement runs inside `requestAnimationFrame` as one write pass, one read pass, and one restore, so the component does not reflow per card. `offsetHeight` is used rather than `getBoundingClientRect().height` because the stage is CSS-scaled and the layout works in unscaled world units. A card whose ancestor is not laid out reports zero and keeps the estimate instead of collapsing to the minimum.

The character estimate remains only as the fallback for renderers with no document to measure, and it now advances wide (CJK, Hangul, fullwidth) characters at twice the narrow width. `MAX_CARD_H` is gone: a card grows to fit its text, because hiding a task description defeats the purpose of showing the plan.

`focusTargets` frames the active cards together with every card in their layers plus exactly one level of children. The active node stays centred, its parallel siblings and its immediate successors are visible, and deeper rows remain reachable by panning instead of shrinking the whole graph to fit. Both focus paths — the `focusNodeId` effect and `focusActiveNodes` — use it.

## Alternatives considered

**Keep estimating but make the constant CJK-aware.** The estimate already had to be wrong for mixed text: a single advance cannot represent a string whose run mixes 7.1px and 14.3px glyphs, and the measured per-string average varied from 7.7px to 10.3px for the same font. Correcting it to a worst-case width would over-size Latin-only cards and still miss font fallback differences between platforms.

**Always join card text onto one line and truncate with an ellipsis.** This removes the layout uncertainty but hides the task description, which is the reason the graph exists; the inspector popover is a deliberate second level of detail, not a replacement for reading the plan.

**Let cards scroll internally.** A scrollable card inside a pannable, zoomable canvas gives two competing scroll targets under the pointer and would need its own affordance to signal hidden text. Growing the card is unambiguous.

**Shrink cards to fit the widest layer at 100% zoom.** Changing card width re-wraps every card and so invalidates the measurements; it also makes the same plan render differently at different panel widths, which is a larger contract change than this defect needed.

**Frame only the active card but allow zoom below 1 to include its siblings.** This was the observed behaviour with `scale` clamped to 1 and would still leave the user reading 40–60% text to see the layer. The layer is what carries the meaning, so the window moves rather than the type getting smaller.

## Consequences

Card height is now correct for any mix of scripts and any font the platform resolves, because the document is the source of truth. The cost is one measurement pass per layout change: `height: auto` on all cards, a read of each card's `offsetHeight`, then a restore. This runs in an animation frame and is skipped when no height changed, so a status flip that does not re-wrap costs nothing. Layout is recomputed once after measurement converges, and measurement is keyed by card width to avoid reusing heights taken at the previous width.

Auto-focus no longer shows the entire graph. Deeper rows are intentionally off screen: the trade-off is that a long plan scrolls by dragging, while the active row and what it leads into are always legible. `fitView` still frames everything for readers who want the full shape.

The card no longer clips, so a very long task description produces a tall card. Layer heights already take the maximum of their row, so one long card stretches its row rather than overlapping neighbours.
