# PR 09 — Workspace surface alignment

## Intent

Align the shared workbench surface language so panels provide structure, rows provide grouping, and selection uses a quiet rail instead of another heavy border box.

## Changes

- Reduce the visual weight of generic `.workbench-row-surface` outlines with a semantic mixed border.
- Keep row separation through the existing workbench surface tokens.
- Add a narrow selected rail to `.workbench-selected-surface`.
- Preserve panel-specific surfaces, hover states, plugin lifecycle behavior, and lazy loading.

This PR changes shared workbench selectors only; it does not claim page-specific Notes or Blueprint redesigns. Those surfaces will inherit the shared rule only where they already use these selectors.

## Review visual

See `assets/pr-09-workspace-surfaces.svg` for a schematic comparison. It is a hand-authored design review artifact, not a runtime screenshot or browser regression capture.
