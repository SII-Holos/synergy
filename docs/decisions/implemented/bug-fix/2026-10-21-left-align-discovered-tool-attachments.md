# Decision Record: Left-align automatically discovered tool attachments

Status: implemented

The shared image geometry and ordinary tool gallery sizing are extended by [tool attachment views](../feature/2026-10-23-tool-attachment-views.md); this record retains the rationale for removing nested evidence insets.

## Problem

Compact tool evidence inherits both an evidence inset and a nested gallery margin, with row padding adding another offset. Automatically discovered document cards therefore start 52 pixels to the right of surrounding assistant and tool rows. Separate deliverable galleries are already left-aligned and do not reproduce this defect.

## Decision

Tool evidence attachments share the left edge of their activity row. The evidence container owns its vertical spacing; attachment galleries do not inherit the specialized-detail indentation. Its compact row layout keeps vertical padding but no horizontal inset. Document card sizes, natural wrapping, resource descriptors and opening behavior remain unchanged. User attachment and independent deliverable layouts retain their existing rules.

## Alternatives considered

**Move every attachment gallery.** It changes already-aligned deliveries and user-authored attachment placement rather than fixing the nested evidence styles.

**Add an opposing negative margin.** It conceals the two original insets and leaves gallery width and clipping dependent on them.

## Consequences

Tool attachments read as part of the same left-aligned conversation rather than an indented subview. Specialized tool details retain their indentation. Real virtual-conversation browser coverage uses the evidence presentation purpose for one and two HTML documents at phone and desktop widths in both themes, verifies wrapping and containment, and exercises keyboard dispatch of the original attachment. A separate deliverable case protects its independent gallery.
