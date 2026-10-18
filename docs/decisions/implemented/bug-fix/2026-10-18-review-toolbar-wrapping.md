# Decision Record: Review toolbar wrapping follows content width

Status: implemented

## Problem

Review allocated separate metadata and tool rows below a fixed panel width even when both groups could fit together. This left unused horizontal space and reduced the visible diff height.

## Decision

The toolbar uses wrapping flex layout. Metadata grows into available space, while reading tools retain their complete group and target sizes. Both groups share a row whenever they fit; otherwise tools wrap beneath the metadata. Long branch references remain truncated inside the metadata group and retain their full accessible labels and editor values.

This supersedes only the narrow-pane row allocation in [review navigation and reading controls](../feature/2026-10-04-review-navigation-and-reading-controls.md). Existing touch overflow controls and file-sidebar breakpoints remain independent.

## Alternatives considered

**Lower the fixed wrapping breakpoint.** A smaller threshold would still assume a particular source label, total width, reference length and input target size. Intrinsic layout responds to their actual combined width.

**Force a single row at every width.** This would require shrinking targets or clipping controls on phone-sized panes. Wrapping the intact group preserves access to the controls.

## Consequences

Toolbar height depends on its content as well as panel width. Rendered regression tests cover shared rows at intermediate widths, wrapping on small panes, long branch references, touch targets, zoom and retained viewer identity. No runtime width measurement or comparison-state change is needed.
