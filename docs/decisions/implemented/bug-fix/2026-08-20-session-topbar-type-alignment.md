# Decision Record: Align session top-bar type to one baseline

Status: implemented

## Problem

The desktop session top bar's left cluster — folder icon, project name, `/`, model name, and thinking-effort label — looked misaligned. Three independent type treatments sat on one row: an 18px/600 project name, a 21px/400 IBM Plex Mono slash, an 18px/650 model button, and a 15px/520 effort label. Different cap heights, extra-bold weights outside the token scale, a larger monospace slash, overlapping selector-button padding, and a 38px button next to unpadded text made the row feel like three fonts at three heights.

## Decision

The left cluster now shares one sans family and one 20px line box. Project name, slash, and model use `--font-size-base` with `--font-weight-semibold` (slash stays regular). Effort stays one step quieter at `--font-size-small` / `--font-weight-medium`, still on the same 20px line. The folder icon and project name group as `.stb-project` with an 8px gap; the row gap is also 8px. Selector buttons are 32px tall so they match the icon/text box instead of sitting taller than the identity labels. Local pixel sizes, 650/520 weights, the monospace slash, and the overlapping `margin-left: -4px` between selectors are gone.

## Alternatives considered

- **Keep 18px display type and only equalize line-height** — rejected: 18px is `--font-size-large`, too loud for chrome next to a 20px icon, and the effort label would still need a second size that could not share a cap height.
- **Keep the monospace slash as a breadcrumb token** — rejected: IBM Plex Mono at 21px sits on a different baseline and cap height than Inter, which is the actual misalignment users see.
- **Make effort the same size and weight as the model name** — rejected: effort is a secondary control; size/weight hierarchy should stay, only the line box should match.
- **Optically nudge each glyph with padding or translate** — rejected: that papers over mixed metrics instead of putting the cluster on one type scale.

## Consequences

- Session chrome still names the project and still uses the folder icon; only the type metrics and grouping changed.
- The top bar now uses the same semantic size/weight tokens as the rest of the product chrome, so later theme or type-scale edits apply without another local pixel override.
- Mobile already used a 32px selector; desktop now matches that height, so the two layouts no longer fight each other on type.
