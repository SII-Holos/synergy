# Decision Record: Media-generation deliveries render inline in the session timeline

Status: implemented

## Problem

Completed media-generation tool results share the `tool-attachments` timeline path with `attach` deliveries. Since the collapsible-card follow-up ([tool-attachments-collapsible-card](../../archived/bug-fix/2026-08-22-tool-attachments-collapsible-card.md)), that shared path wrapped every delivery — media included — in a `BasicTool` collapsible. Generated media consequently presented as a titled tool card with a chevron instead of flowing into the conversation like message attachments: for content whose whole point is to be seen (images, video, audio), the card chrome adds a boundary the media flow never asked for, and diverges from how the same media reads when delivered as a plain attachment part.

## Decision

`TimelineItemDisplay` in `packages/ui/src/components/session-turn.tsx` splits the shared path by display policy: `tool-attachments` items whose tool part is a media-generation tool (`isMediaGenerationToolPart`) render as a bare `AttachmentGallery` inline in the conversation flow, with no collapsible trigger. Every other hidden-card delivery (attach, and any future tool that hides its card without media semantics) keeps the `DeliveredAttachmentsCard` — a `defaultOpen` `BasicTool` collapsible with filename/count subtitle and size tag. Pending media generation still renders `MediaGenerationCard`; timeline kinds, spacing rules, slot placement, and activity passthrough are unchanged — only the completed-media presentation reverts to the inline gallery it had before the collapsible wrap. The DOM test `session-turn-attachments-collapse.dom.test.ts` pins both behaviors side by side.

## Alternatives considered

**Keep the uniform collapsible card (the superseded decision)** maximized consistency of the shared path, but treated generated media as a file-delivery transaction; the regression — media that used to flow into the conversation now sat behind a tool-card header — is exactly what this change reverts; rejected.

**Move media-generation out of the `tool-attachments` timeline kind into a dedicated kind** would encode the split in the projection layer instead of the renderer, but duplicates projection, stable-key, spacing, and activity-passthrough wiring for a purely presentational distinction; rejected as a larger blast radius for the same pixels.

**Hide the completed tool card entirely (render nothing)** loses the delivered media; the attachment must stay visible; rejected.

## Consequences

Generated media again reads as conversation content: no header, no chevron, no collapse — identical chrome to a user-attachment gallery. Attach keeps its titled collapsible, so multi-file deliveries remain collapsible there. The shared render path now has one policy branch, and the split lives in the renderer where display metadata is already resolved. Supersedes the uniform-collapsible decision for media deliveries only; the attach half of that decision still stands as restated here.
