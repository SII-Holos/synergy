# Decision Record: Fill-only shared secondary controls

Status: implemented

## Problem

The shared secondary `Button`, and the `IconButton` that defaults to that variant, drew a resting 1px `--border-base` perimeter on top of the same neutral inset fill that borderless controls already use. In light mode that perimeter is 14% black and in dark mode 10% white, so the control read as a heavier slab beside the controls it sits next to; the "connect provider" action in the model-unavailable notice looked like an older control family than the Settings actions it resembled. Settings had solved the same problem locally by zeroing borders inside its own frame, which left every surface outside Settings free to reintroduce the heavier edge.

## Decision

Secondary controls are defined by their neutral inset fill alone. `packages/ui/src/components/button.css` and `packages/ui/src/components/icon-button.css` set `border-color: transparent` for the secondary resting state, keep `box-shadow: none`, and give the disabled secondary button the shared disabled surface and text instead of a disabled perimeter. The border keeps its 1px width, so the box, padding, hit target and rounding geometry do not shift and no control moves by a pixel.

This is a shared-variant decision, not a surface decision. Primary and ghost buttons, text and numeric fields, menu and popover boundaries, cards, chips, tags, badges, entity rows and the Composer's intentional hairline Add button keep their own treatments. The plugin text-action retry action, which had hand-written `border border-border-base` on a transparent background, adopts the same fill-only treatment rather than keeping a local variant of the heavier style.

An audit of the remaining hand-written perimeters found that most of them are not this control family and were left unchanged: workbench control pills and rounded chips compute to a 6% `--workbench-border` hairline rather than the 14% `--border-base` edge, and menu, card, input and separator perimeters belong to other roles. [Settings control surfaces](./2026-10-20-settings-control-surfaces.md) still owns its scoped rule, including its stricter zero-width treatment inside the Settings frame.

## Alternatives considered

**Change the fill token instead of removing the perimeter.** Rejected because `--button-secondary-base` and `--surface-inset-base` resolve to the same value in both themes (`#F0F0F0` / `#292929`). The perceived weight came only from the perimeter, so recoloring the fill would have darkened controls that already matched their neighbours, and lightened them in dark mode where the inset fill is already the brighter surface.

**Remove the border entirely with `border: 0`.** Rejected because it changes the computed width from 1px to 0 and shifts every secondary control by a pixel. The Settings regression asserts that an outside-Settings secondary button keeps its 1px width, which is the geometry contract this decision preserves.

**Keep the fix scoped to Settings or to per-surface class strings.** Rejected because the shared variants are the source of the appearance. A scoped rule leaves each new surface free to choose the heavier edge again, and per-surface edits accumulate as competing declarations that the next control does not inherit.

**Recolor every `border-border-base` usage.** Rejected because the same token draws menu boundaries, cards, separators and input perimeters. Those remain separate roles that a resting action style must not flatten.

## Consequences

Secondary actions now read as quiet filled controls everywhere, and new surfaces inherit that appearance without a local override. The cost is that a secondary control no longer expresses an edge at all: when it sits on a container with the same fill, the boundary has to come from a different surface role rather than from a border, which is the same constraint Settings already accepted. Icon buttons that default to secondary keep their previous 1px geometry, so only their color changed and no 64 call sites needed edits.

The browser regression in `apps/web/test/components/settings/settings-details.dom.test.tsx` asserts the transparent border color and the retained 1px width for an outside-Settings secondary button, so a future change to `border: 0` fails rather than silently shifting geometry. Theme and token contracts continue to resolve through the public semantic tokens, and no surface gains a private palette.
