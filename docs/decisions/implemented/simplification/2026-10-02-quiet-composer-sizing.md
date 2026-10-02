# Decision Record: Keep composer sizing controls quiet and directly reachable

Status: implemented

## Problem

A separate sizing row and menu consume writing space while duplicating the drag separator and expansion action. A square window glyph does not communicate expansion of the message editor. Capping the editor height without showing continued drag progress makes the expansion threshold difficult to discover.

## Decision

The normal composer reserves only eight pixels at its top. A two-pixel grip floats on the edge with an independent 24-pixel pointer target. The expansion control floats in the top corner without adding a row. It uses outward diagonal arrows for expansion and inward arrows for contraction, with dedicated composer semantic tokens; desktop window icons keep their existing meanings.

On pointer devices, the control appears when the pointer enters its corner region or keyboard focus reaches it. On touch devices it remains visible with a 44-pixel target. The corner is reserved beside the attachment rail and the editor's existing trailing gutter. Focus indicators and tooltips remain available. The size menu is removed; the separator provides arrow-key resizing, Home for automatic height, End for maximum manual height and Enter for expansion.

Beyond the manual height limit, pointer movement drives a bounded pull effect and a progress instruction without growing the editor past its cap. At 32 additional pixels, the instruction changes to release-to-expand. Returning to the limit disarms expansion; pointer cancellation or Escape clears feedback and restores the preceding height. Reduced motion keeps the instruction and state color without transforms. A ResizeObserver keeps the separator's accessible bounds aligned with the actual editor chrome instead of the initial layout.

Expansion and contraction measure the live surface before changing layout, then animate height and column width using the browser's Web Animations API. Expansion takes 340 milliseconds and contraction 240 milliseconds, both with a controlled ease-out. Top spacing, the editor gutter, formatting tools and preview tracks share that timing, so none appears as a separate layout jump. The same editor remains mounted; the bottom action stays anchored and text is never scaled. An interrupted transition captures the currently visible geometry and transforms before reversing. Typing, manual sizing, viewport changes and reduced-motion changes cancel obsolete geometry. Hidden exiting tools and preview are inert, and unmount releases animations and preference listeners.

The single-editor state and acceptance rules in [long message editing](../feature/2026-10-01-long-message-editor.md) remain unchanged. This refines that record's sizing affordances without adding Plugin services or persisted state.

## Alternatives considered

**Keep a sizing menu beside the expansion control.** It duplicates direct actions and increases the input area's visual density.

**Hide the control on every device.** Touch has no reliable hover discovery, and keyboard users need a visible focused action.

**Stop all feedback at the height limit.** The editor remains bounded but the user cannot see that further dragging can expand it.

**Scale a cloned editor during expansion.** Scaling distorts text and duplicating the editing surface risks native selection, undo and attachment identity. Animate the live surface's geometry instead.

## Consequences

Typing retains more vertical space and one sizing action in the corner. Automatic-height reset and maximum manual height are available through the focusable separator. Attachment reading, editor state, submission and public Plugin interfaces remain compatible.

Real-browser behavior tests exercise intermediate expansion/contraction geometry, bottom anchoring, reversal, native selection and undo, scroll preservation, typing during motion, manual sizing, viewport interruption, preference changes and unmount cleanup. Geometry interpolation performs layout work for a short, bounded transition; pointer resizing does not start an animation.
