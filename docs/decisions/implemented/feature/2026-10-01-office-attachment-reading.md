# Decision Record: Read Office attachments locally within a bounded preview

Status: implemented

## Problem

User attachments need an in-product reading surface for common Office documents. A browser reader must handle compressed input without blocking chat, accessing external resources or promising print-level fidelity.

## Decision

Office adapters load only after an attachment is opened. A disposable Worker validates the ZIP directory and actual streamed expansion, including CRC and decoded-size checks. Input is limited to 50 MiB, decoded contents to 200 MiB and entry count to 4096. External relationships and active or embedded executable parts are excluded from a separate preview package. Original bytes and download URLs remain untouched.

DOCX uses pinned `docx-preview 0.4.1` and its stable `renderAsync` API. HTML altChunks are disabled. Rendering occurs into a detached document, uses embedded data resources and publishes only for the current preview generation. Sanitized pages enter an opaque sandboxed frame with no scripts, connections, child frames, forms or external resource access. Existing file page breaks, text, tables, images, headers and footers are readable; navigation, zoom and text search remain in host controls.

The reading contract preserves content and primary structure. HTML cannot reproduce automatic Word pagination or every complex layout. The reader explicitly states that preview layout may differ from the original. Damaged, encrypted, oversized, unsupported and failed reads retain distinct states and the original download action. Closing or replacing a preview terminates its Worker and rejects late replies.

## Alternatives considered

**Perform conversion through a server Office suite.** This adds a backend dependency and changes the privacy and deployment boundary for a read-only frontend feature.

**Render unvalidated files directly in the chat page.** ZIP expansion and active or external resources would have no independent execution or presentation boundary.

## Consequences

Office preview does not edit files, execute macros, refresh external data, change upload policy or alter model input. Optional readers do not join the chat startup bundle. Fidelity depends on browser layout and the specific file; the original remains the reference.

## Sources

- [DOCX stable rendering API and page-break limits](https://github.com/VolodymyrBaydalka/docxjs) define the DOM adapter and fidelity contract.
- [fflate streaming ZIP API](https://github.com/101arrowz/fflate) provides decompression inside the bounded Worker.
- [Saxes XML parser](https://github.com/lddubeau/saxes) handles relationships with namespace and entity decoding before resource filtering.
