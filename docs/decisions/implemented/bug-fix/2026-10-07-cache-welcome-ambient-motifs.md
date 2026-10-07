# Decision Record: Cache welcome ambient pixel motifs

Status: implemented

## Problem

The independently moving welcome background repaints every occupied sprite cell on each frame, although its seven motif masks and foreground ink are unchanged. Editing pauses gameplay but not this background, so repeated cell painting remains active during ordinary draft work.

## Decision

`AmbientField` owns seven tightly sized Canvas buffers, one per existing motif mask with detail cells removed. It paints them at unit scale for the resolved `text-strong` token and rebuilds them only when that token changes, including same-mode theme switches. Each seeded mark keeps its motif choice, drift, opacity and edge fade. At integer effective device-pixel ratios, frames copy the buffers at the existing integer one- or two-pixel scale with smoothing disabled and rounded positions matching the sprite cell renderer. Fractional device-pixel ratios retain direct cell painting: nearest-neighbor copies change edge coverage and alpha when the destination grid is not aligned, so the cache is not valid there.

Resize redraws the destination without rebuilding unchanged motifs. Disposal zeroes the owned buffers. The [independent ambient motion](2026-10-04-independent-welcome-background-motion.md) decision remains authoritative for document visibility, reduced motion and gameplay pause behavior.

## Alternatives considered

**Continue painting cells each frame.** It retains the simplest immediate-mode path but repeats unchanged motif work for every mark.

**Cache each mark or the complete background.** Per-mark buffers duplicate identical motif pixels; a complete background image would couple caching to animated positions, opacity and pane dimensions. Neither retains the small reusable cache without additional invalidation.

**Cache fractional grid phases and opacity.** This would add phase-dependent raster buffers and opacity-dependent invalidation to preserve the direct cell renderer's overlapping edge composition. The bounded integer-grid optimization avoids that extra state while leaving fractional rendering unchanged.

**Reduce or pause decoration during editing.** It would change the accepted independent-motion behavior rather than remove redundant rendering work.

## Consequences

The component retains seven small pixel buffers until disposal and invalidates them on foreground-ink changes. No game renderer, frame cadence, selection, draft or motion gate changes. The browser regression counts destination and all offscreen sources used by integer-grid ambient drawing, so moving frames and resize must add no cell paints while theme invalidation repaints the masks once. It also verifies buffer release and restores instrumented Canvas prototypes. A real device-scale regression compares integer and fractional rendering with the direct-cell reference in both themes and wide and narrow panes. Existing gameplay, visibility and reduced-motion tests remain intact; machine-dependent timing is not a CI acceptance signal.

At integer device scales, frozen captures preserve occupied ambient coordinates and alpha; their composited RGB can differ from direct cell painting by one 8-bit quantization level. Fractional scales use the unchanged direct-cell path. Exact transparent PNG RGBA identity is not the visual contract.
