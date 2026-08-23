# Decision Record: Files workbench PDF visual preview

Status: implemented

## Problem

The Files workbench could only preview UTF-8 text and inline images. Opening a workspace PDF (or any other binary file) showed an icon, the MIME type, the byte size, and "Binary files do not have a text preview" — the `workspace.files.read` route classified `.pdf` as unsupported binary and returned no bytes, so users could not inspect PDF content without leaving Synergy.

## Decision

The Files workbench now renders workspace PDFs with a real document preview. The backend exposes a separate PDF-only byte stream, and the frontend renders through the shared `AttachmentPdfPreview` component, which wraps the official pdf.js viewer components (`PDFViewer` + `EventBus` + `PDFLinkService` from `pdfjs-dist/web/pdf_viewer.mjs`).

- `GET /workspace/files/content` (`operationId: workspace.files.content`) streams the raw bytes of a PDF inside the active workspace with `Content-Type: application/pdf` and `Cache-Control: no-store`. It runs through the same `WorkspaceFileService.resolve` + `assertRealpathInside` path checks as every other workspace route, accepts `.pdf` by extension (case-insensitive) or `application/pdf` MIME, rejects non-PDF files with `WorkspaceFileUnsupportedPreviewError` (400), rejects files over 50 MiB with `Workspa…
- The JSON `workspace.files.read` contract is unchanged: a PDF still returns `kind: "binary"` metadata. PDF bytes never enter the text/image/binary union or the 32 MiB frontend document cache.
- `packages/app/src/context/file/index.tsx` owns a separate PDF byte cache (`store.pdfs`): a 50 MiB client cap, generation-guarded staleness (switching tabs discards stale in-flight responses instead of aborting them), a shared document concurrency gate, and an LRU that keeps at most two decoded buffers, protecting open tabs.
- `packages/app/src/components/file-workbench/content.tsx` classifies PDFs as `{ kind: "pdf", defaultMode: "preview", dual: false }` and renders `AttachmentPdfPreview` with Files-native loading, too-large, and error/retry states. Non-PDF binary files keep the existing placeholder.
- `packages/app/src/components/attachment-workbench/pdf-preview.tsx` hosts the official pdf.js viewer components in continuous vertical scroll mode (lazy per-page rendering with off-screen canvas recycling), with the pdf.js text layer enabled for native text selection/copying. The fit-width button is a real toggle between `"page-width"` and `1` scale, and the host re-applies the `"page-width"` preset on container resize (the components' own ResizeObserver only tracks height). The viewer's vendor CSS is imported through a shim (`pdf-viewer-vendor.css`) that re-asserts the app theme's `color-scheme` at `html:root` specificity so the vendor's `:root { color-scheme: light dark }` cannot leak onto the document root.

The previous hand-rolled single-canvas renderer (`pdf-render.ts` / `createPdfRenderCoordinator`) and its test were removed; `pdfjs-dist` stays pinned at 5.4.296 and the viewer module reads its core API from `globalThis.pdfjsLib`, which the component assigns before importing the viewer module.

## Alternatives considered

- **Extending JSON `workspace.files.read` with `kind: "pdf"` + base64 content** — rejected: a 50 MiB PDF would blow past the 32 MiB document cache, force the whole file into a JSON parse, and mix binary payloads into the text/image metadata union.
- **Extracting PDFs (and Office files) to Markdown in the Files panel** — rejected: the user asked for a real document preview, and text extraction does not render the document's actual layout.
- **Building a separate PPT/Office visual preview** — rejected: the repository has no Office slide-rendering owner; it would add a heavy dependency and a second preview stack. PPT/PPTX/DOCX/XLSX stay on the unsupported placeholder.
- **iframe / `<object>` / Browser-panel preview via a temporary URL** — rejected: the SPA CSP forbids `object-src`, the Browser runtime forbids faking workspace files as browser pages, and there is no workspace raw-URL contract.
- **Copying workspace PDFs into the Asset store and reusing `/asset/:id`** — rejected: that would add parallel persistence and cleanup lifecycles and leak workspace files into the global asset cache.
- **Writing a second pdfjs viewer inside the Files workbench** — rejected: the attachment workbench already ships a tested renderer and worker wiring; the Files workbench renders through that same component.
- **Hand-rolling a text layer and multi-page virtualization on top of the single-canvas renderer** — rejected: the pdf.js maintainers explicitly advise against hand-built text layers (they are the primary source of text/canvas misalignment under DPR, zoom, and rotation), and the official components already implement lazy rendering and off-screen canvas recycling.
- **Adopting a third-party Solid wrapper (e.g. `@pdfslick/solid`)** — rejected: it adds a framework abstraction and a Zustand dependency on top of the same pdf.js components, and the direct component glue is only about a hundred lines.
- **Routing through `Document.extract` / `scan_document`** — rejected: that is the agent tool boundary with its own permissions, timeouts, and Markdown output; it is not the File workbench data plane.

## Consequences

- Opening a workspace PDF shows a real, continuous-scroll, zoomable, text-selectable preview inside the Files workbench, with the same interaction model as attachment PDFs.
- PDF bytes stay out of the JSON read contract and the document cache; the new 2-buffer LRU bounds memory regardless of how many PDF tabs are opened.
- The generated SDK gained `workspace.files.content`; the `WorkspaceFileReadResult` union was not extended.
- PPT and other non-PDF binary files behave exactly as before, and `scan_document` / agent tool behavior is untouched.
- No persistence, config, or migration changes; rolling back is a matter of removing the route and the Files PDF branch.
