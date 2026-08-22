# Decision Record: Delivered attachments render as collapsible cards in the session timeline

Status: implemented

## Problem

Hidden-card tool results (`attach`, media-generation tools) route to the shared `tool-attachments` timeline path. When that path first shipped a raw auto-expanded `AttachmentGallery`, delivered files became immediately visible without a click, but the gallery had no collapse affordance: multi-file or large deliveries permanently consumed vertical timeline space, silently dropping the collapse capability the ordinary tool card (`BasicTool` collapsible) had always provided. The gap surfaced only in live instance testing — the routing tests and CI gates were all green.

## Decision

`tool-attachments` timeline items render through `DeliveredAttachmentsCard` in `packages/ui/src/components/session-turn.tsx`: a `BasicTool` collapsible with `defaultOpen`, so deliveries stay immediately visible while regaining one-click collapse. The trigger header reuses existing semantic sources — icon/title from `getToolInfo` with `classifyTool` as the fallback for unknown or plugin tools, subtitle showing the single filename or the pluralized file count, and a total-size tag. The `AttachmentGallery` renders as the collapsible content. The behavior applies uniformly to every tool on the shared path (attach and media generation alike), pinned by a DOM behavior test that expands, collapses, and re-expands both tool kinds.

## Alternatives considered

**Raw auto-expanded gallery** kept the zero-click intent and nothing else; live testing found the lost collapse, and large deliveries could not be tucked away, so it was rejected.

**Keep the pre-change collapsed-by-default tool card** preserved collapse but required a click before any delivered file was visible, defeating the purpose of surfacing deliveries immediately; rejected.

**Collapse only attach, leave media-generation tools as a raw gallery** split presentation semantics on one shared code path with no user-visible benefit; rejected for consistency.

## Consequences

Deliveries are visible without a click and collapsible with one. Both attach and media results gain a titled card header (icon, title, filename/count, total size) instead of a bare grid, and unknown or plugin tools get classifier-derived semantics rather than raw tool names. The change costs a second rendering layer around the gallery and one exported size helper (`attachmentSize`), and the DOM harness pattern (Vite-built fixture plus JSDOM) is now the precedent for testing collapse behavior that projection tests cannot see.
