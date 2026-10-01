# Decision Record: Read Office attachments locally within a bounded preview

Status: implemented

## Problem

User attachments need an in-product reading surface for common Office documents. A browser reader must handle compressed input without blocking chat, accessing external resources or promising print-level fidelity.

## Decision

Office adapters load only after an attachment is opened. A disposable Worker validates the ZIP directory and actual streamed expansion, including CRC and decoded-size checks. Input is limited to 50 MiB, decoded contents to 200 MiB and entry count to 4096. External relationships and active or embedded executable parts are excluded from a separate preview package. Original bytes and download URLs remain untouched.

DOCX uses pinned `docx-preview 0.4.1` and its stable `renderAsync` API. HTML altChunks are disabled. Rendering occurs into a detached document, uses embedded data resources and publishes only for the current preview generation. Sanitized pages enter an opaque sandboxed frame with no scripts, connections, child frames, forms or external resource access. Existing file page breaks, text, tables, images, headers and footers are readable; navigation, zoom and text search remain in host controls.

XLSX uses the official SheetJS CE 0.20.3 release package, pinned by the lockfile SHA-512 integrity. Validation and parsing run in the disposable Worker; the main thread receives only a typed sparse workbook projection. The virtual grid preserves worksheet names, merged regions, row and column sizes, formatted cached values and formula text. It does not evaluate formulas or refresh data. Keyboard navigation, cell-range copy and text search operate on this same projection. Very large row canvases map physical scrolling to logical rows rather than allocating one DOM node per cell. Copy explicitly rejects selections above 100,000 cells instead of silently truncating content.

PPTX uses pinned `@office-kit/pptx 0.21.0` and `@office-kit/pptx-preview 0.12.0`. The Worker loads the validated package and produces static SVG plus search text from shapes and table cells. Embedded images, text, tables and common shapes retain their primary structure. A reader-scoped sanitizer permits the generated SVG's HTML text integration points, strips active elements and animation, and confines the result to the opaque frame. DOCX and PPTX share page navigation, width fitting, zoom and literal text search; highlighting follows split text runs and preserves SVG namespaces.

The reading contract preserves content and primary structure. HTML cannot reproduce automatic Word pagination or every complex layout; slide rendering is approximate. The reader explicitly states that preview layout may differ from the original. Damaged, encrypted, oversized, unsupported and failed reads retain distinct states and the original download action. Closing or replacing a preview terminates its Worker and rejects late replies. A replacement document resets page navigation before reading, including when it has fewer pages. Reader loading failures remain inside the attachment surface, with original-file actions reachable. Browser regression fixtures keep separate temporary Vite caches so validation does not overwrite a live development app’s optimized modules.

## Alternatives considered

**Perform conversion through a server Office suite.** This adds a backend dependency and changes the privacy and deployment boundary for a read-only frontend feature.

**Render unvalidated files directly in the chat page.** ZIP expansion and active or external resources would have no independent execution or presentation boundary.

## Consequences

Office preview does not edit files, execute macros, refresh external data, change upload policy or alter model input. Optional readers do not join the chat startup bundle. Fidelity depends on browser layout and the specific file; the original remains the reference.

## Sources

- [DOCX stable rendering API and page-break limits](https://github.com/VolodymyrBaydalka/docxjs) define the DOM adapter and fidelity contract.
- [fflate streaming ZIP API](https://github.com/101arrowz/fflate) provides decompression inside the bounded Worker.
- [Saxes XML parser](https://github.com/lddubeau/saxes) handles relationships with namespace and entity decoding before resource filtering.
- [SheetJS official installation source](https://docs.sheetjs.com/docs/getting-started/installation/frameworks/) supplies the versioned CE distribution.
- [SheetJS cell model](https://docs.sheetjs.com/docs/csf/cell/) defines cached values, formatted text and formula ownership.

- [Office Kit slide preview boundaries](https://github.com/office-kit/pptx#preview-and-text-overflow-checks) establish static rendering and approximation limits.
- [DOMPurify configuration and sanitization](https://github.com/cure53/DOMPurify) define markup cleanup within the isolated document boundary.
