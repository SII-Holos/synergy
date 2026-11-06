# Decision Record: Use one visible hairline for side-pane resizing

Status: implemented

## Problem

Sidebar and side-workspace separators use the same shared handle but paint different apparent thicknesses. The sidebar exposes its full three-pixel pseudo-element, while the workbench clips the half positioned outside its edge.

## Decision

The shared horizontal resize handle paints a one-pixel line aligned with the pane edge rather than centering an odd-width line across it. Both start and end edges expose the full line. The eight-pixel pointer target, focus cue, pointer capture and keyboard sizing remain unchanged. Vertical sizing handles retain their existing presentation.

## Alternatives considered

**Reduce only the sidebar with a local override.** It leaves shared separators inconsistent and still makes the workbench's appearance depend on clipping.

**Shrink the interactive handle to one pixel.** It makes pointer resizing harder without improving the painted result.

## Consequences

Both side-pane boundaries use the thin workbench treatment without reducing resizing access. Browser coverage loads the production sidebar and workbench container styles with the real shared control, measures the visible line after clipping, and exercises drag direction, keyboard focus, arrow steps and Home/End limits in both color schemes.
