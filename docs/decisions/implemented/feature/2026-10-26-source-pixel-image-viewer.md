# Decision Record: Source-pixel image viewing

Status: implemented

## Problem

Image previews previously treated a fitted image as 100%, retained unreachable pan offsets, and did not refit a rotated image. Independent modal and workbench transforms made these semantics inconsistent.

## Decision

`packages/ui/src/components/image-viewer-model.ts` owns source-pixel geometry. Actual size means one source pixel per CSS pixel. Fit contains the rotated bounds without enlarging small images. Zoom anchors the source point beneath the pointer; boundary correction takes precedence when an edge would otherwise become unreachable. Manual zoom survives viewport resizing, while fit is recomputed.

Rotation is in quarter turns. Pan is clamped against the displayed rotated bounds and centers axes that do not overflow. Image identity includes both entry ID and source, so gallery entries sharing a URL remain distinct. Model tests cover these invariants, modifier-aware keyboard routing, wheel input, and viewports smaller than normal padding.

## Alternatives considered

**Keep fit-relative percentages.** Rejected because 100% would still conceal source pixels and mean different things in differently sized surfaces.

**Maintain separate modal and workbench transform models.** Rejected because boundary, rotation, and input fixes would continue to diverge. Shells supply resources and host actions rather than implementing geometry.

## Consequences

The geometry is independently testable without a browser, but browser tests remain necessary for pointer capture, image loading, focus, menus, and actual rendered dimensions. Fit is the minimum useful scale; zoom can reach eight times source size. This limits meaningless empty-canvas zooming without preventing inspection of large images.
