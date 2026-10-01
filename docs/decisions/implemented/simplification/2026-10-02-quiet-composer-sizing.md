# Decision Record: Keep composer sizing controls quiet and directly reachable

Status: implemented

## Problem

A separate sizing row and menu consume writing space while duplicating the drag separator and expansion action. A square window glyph does not communicate expansion of the message editor.

## Decision

The normal composer reserves only eight pixels at its top. A two-pixel grip floats on the edge with an independent 24-pixel pointer target. The expansion control floats in the top corner without adding a row. It uses outward diagonal arrows for expansion and inward arrows for contraction, with dedicated composer semantic tokens; desktop window icons keep their existing meanings.

On pointer devices, the control appears when the pointer enters its corner region or keyboard focus reaches it. On touch devices it remains visible with a 44-pixel target. The corner is reserved beside the attachment rail and the editor's existing trailing gutter. Focus indicators and tooltips remain available. The size menu is removed; the separator provides arrow-key resizing, Home for automatic height, End for maximum manual height and Enter for expansion.

The single-editor state and acceptance rules in [long message editing](../feature/2026-10-01-long-message-editor.md) remain unchanged. This refines that record's sizing affordances without adding Plugin services or persisted state.

## Alternatives considered

**Keep a sizing menu beside the expansion control.** It duplicates direct actions and increases the input area's visual density.

**Hide the control on every device.** Touch has no reliable hover discovery, and keyboard users need a visible focused action.

## Consequences

Typing retains more vertical space and one sizing action in the corner. Automatic-height reset and maximum manual height are available through the focusable separator. Attachment reading, editor state, submission and public Plugin interfaces remain compatible.
