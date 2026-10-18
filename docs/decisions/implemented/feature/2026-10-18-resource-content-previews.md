# Decision Record: Content previews for message resources

Status: implemented

## Problem

Hovering a displayed message image created a second card with an internal Asset address and no content. Other references repeated technical addresses and explanatory fallback copy, obscuring the excerpt and opening action.

## Decision

Exclude rendered images from delayed hover and focus previews while preserving their existing direct image-viewer action. Text references can show an image thumbnail, numbered file excerpt, Note section or anonymous webpage summary. Reuse the App resource opener, canonical format classifier, captured Workspace generation, live drafts and owner-scoped preview cache. Immutable text Assets use the generated SDK and stop reading after a bounded prefix; image thumbnails use existing resource URL resolution.

Use source, readable name, content and compact actions in a 350-pixel card bounded by the viewport. Copy retains the canonical target; internal Asset and Note URIs are not rendered as duplicate content. Close passive cards without useful content, including failed thumbnails. Explicit touch information actions retain a concise status and direct opening action. Pointer traversal and keyboard focus keep the preview visible; Escape restores the initiating reference. No interaction instructions are displayed in the card.

The opening action uses a borderless text-and-arrow treatment, with a neutral surface only on interaction. Keep a 32-pixel desktop hit area and at least 44 pixels for touch controls; the footer remains outside the excerpt's scrolling region.

This updates the unavailable-source-card behavior in [semantic message references](2026-10-16-semantic-message-references.md); its parsing, authority, ownership and native opening contracts remain in force.

## Alternatives considered

**Show a generic card for every resource.** Rejected because displayed images already provide the content and empty cards interrupt reading without helping a decision.

**Load full document readers on hover.** Rejected because bounded excerpts and thumbnails are sufficient for recognition; existing file, image and Note readers remain the explicit opening destinations.

**Hide unavailable references entirely.** Rejected because preview availability does not determine whether a resource can be opened. Links retain direct activation, and explicit information controls remain available on touch.

## Consequences

The shared [preview component](../../../../packages/ui/src/components/resource-preview.tsx) and [Markdown observer](../../../../packages/ui/src/components/markdown-resources.ts) own presentation and triggers. The App [resource provider](../../../../apps/web/src/context/resource-open.tsx) owns reads, cancellation and destination labels. Large text Assets are limited to 24 KiB of decoded input, eleven displayed lines and 6,000 characters; unsupported binary formats retain explicit opening without a passive card. Private webpages still require explicit navigation.

Behavior is covered by [browser interaction tests](../../../../packages/ui/test/components/resource-preview.browser.test.ts) and [App resource tests](../../../../apps/web/test/context/tool-resource-open.dom.test.ts), including direct image activation, thumbnail failure, original-target copying, unavailable content, draft preference, bounded streams, captured Workspace URLs, focus, narrow layouts and stale-owner cancellation. The durable product contract is in [PRODUCT.md](../../../../apps/web/PRODUCT.md) and [Workspace and files](../../../architecture/workspace-and-files.md#message-resource-opening).
