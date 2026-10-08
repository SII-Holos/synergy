# Decision Record: Markdown terminal reading and stream ownership

Status: implemented

## Problem

Large answers switch from incremental Markdown DOM to a worker-prepared virtual document. Default estimates and an empty intermediate layout can remove the content being read, while a virtualizer that waits for a new scroll event misses the existing viewport offset. The two renderers can wrap or split content differently, so block identity plus a pixel offset does not identify the same reading point. Small deltas also create one settled Text node per update, while merging those nodes exposes increasingly expensive whole-prefix grapheme segmentation.

## Decision

Vertical viewport identity belongs to the native scroll owner. Conversation and process viewports declare that capability on their DOM element before content exists; streaming capture and terminal virtualization resolve the same ancestor. The nearest declaration takes precedence over incidental native overflow; only an ancestor chain with no declaration uses its nearest native container with actual vertical overflow. CSS cross-axis computation can make a content-sized horizontal scroller report vertical `auto`, so computed overflow alone cannot identify the owner. Declaration keeps cold documents bound correctly without introducing a DOM registry or another recovery controller.

The reading identity is original UTF-16 source position plus viewport pixel offset. The streaming parser maintains compact consumed-source spans in its existing pending and text buffers. Worker token consumption and normative text transformations produce compact reading runs; one generated document identity binds runs to sanitized DOM owners. Character reference normalization uses the pure named-reference table and numeric-reference utility under browser and worker conditions. Text and atomic media use one reading-point resolver. Render-owned code chrome and repeated table headers carry no source, and authored HTML cannot acquire trusted text provenance. Source preparation, splitting and normalization retain original offsets without searching rendered labels or reconstructing Markdown grammar from DOM.

The stream also contributes measured block sizes to the terminal virtualizer. One synchronous layout transaction reserves measured total height before replacing DOM and releases it in `finally` after mount. Virtua accepts sizes through the ordinary resize action and bootstraps the existing viewport offset through scroll and scroll-end actions without starting an input timer. After one hydration microtask, Virtua synchronously accepts mounted content-box measurements, consumes estimate compensation and commits the reading point once as a native idle position. No imperative measurement waiter survives adoption, so wheel, touch and keyboard input immediately become authoritative. Identical-offset scroll delivery retains public scroll callbacks without changing the native scroll direction; range readers can still admit history when a short window has no scrollable overflow. Width and font signatures shared by stream initialization and terminal caches gate geometry reuse, including code-font tokens. Ordinary virtual measurement owns later layout changes. Selection and focus postpone replacement until their current owner releases.

Chunking preserves whole Unicode graphemes and atomic images. Oversized indivisible inline metadata follows the existing source-preserving plain admission, avoiding duplicated media or repeated large URLs. Source chunk targets are distinct from rendered HTML size because highlighting expands markup. Reading and signed-layout metadata count toward the existing Markdown byte budget. Captured stream geometry contains no DOM, Solid owner, parser or event callback.

Settled text reuses its Text node. Arrival completion merges adjacent runs, transfers source segments and preserves range endpoints. Grapheme continuation stores only the last cluster per Text node and segments that cluster plus the new suffix. Streaming and terminal rendering keep their sanitization and resource opening owners.

The authoritative implementation is [Markdown](../../../../packages/ui/src/components/markdown.tsx), [stream provenance](../../../../packages/ui/src/components/markdown-stream-source.ts), [worker blocks](../../../../packages/ui/src/context/markdown-document.ts), [source transformations](../../../../packages/ui/src/context/markdown-source.ts) and the documented [dependency patches](../../../../patches/README.md). Current lifecycle rules live in [frontend data sync](../../../architecture/frontend-data-sync.md#markdown-terminal-handoff).

## Alternatives considered

**Match rendered strings across renderers.** Repeated text, entities, inline syntax and generated code or math chrome make labels ambiguous and introduce another interpretation of source identity.

**Keep block identity plus a pixel offset.** Code, repeated table headers, media and split paragraphs changed the observed reading offsets by 93, 42, 232 and 59 pixels in browser fixtures. The same source content point remains necessary when renderer layout changes inside a block.

**Annotate every glyph or decode syntax again from DOM.** Compact runs from canonical consumption describe normalized text without per-glyph attributes, DOM text searches or another Markdown parser. Atomic constructs keep their own source interval.

**Stage the entire terminal DOM before virtualization.** This defeats the existing DOM bounds and duplicates the most expensive render at completion.

**Construct an opaque Virtua cache from external measurements.** This couples the caller to private cache internals. A typed input accepted through the normal measurement action keeps one layout owner.

**Reparse streamed source after it crosses the large-document threshold.** Provenance would require replaying already accepted content. Tracking compact consumed spans from initialization avoids that replay at the cost of linear parser bookkeeping.

## Consequences

The stream contributes measured initialization and a reading point, then releases its owner. Terminal rendering retains bounded worker blocks and the existing virtualizer. Exact adoption is scoped to unchanged width and font metrics; responsive reflow follows actual canonical measurements. Source tracking adds linear parser work and metadata at flush boundaries, while Text coalescing and suffix-only grapheme work prevent update count from multiplying settled nodes or repeated prefix scans. One indivisible Unicode cluster can exceed the chunk target and remains subject to the document byte budget.

[Browser tests](../../../../packages/ui/test/markdown-virtual.browser.test.ts) measure paint-frame continuity, interaction protection, layout-cache expiry and both Virtua entrypoints. [Parser entrypoint tests](../../../../packages/ui/test/markdown-stream-provenance.test.ts) cover consumed provenance without changing emitted bytes. [Stream tests](../../../../packages/ui/test/markdown-stream.test.ts) cover selection, Unicode, settled node bounds and platform segmentation work after a large prefix. [Worker tests](../../../../packages/ui/test/markdown-document.test.ts) cover source intervals and bounded admission; [reading-point tests](../../../../packages/ui/test/markdown-reading.test.ts) and [source tests](../../../../packages/ui/test/markdown-source.test.ts) exercise canonical normalization and origin ownership.
