# File Workbench

This directory owns the complete read-only file workspace UI:

- `content.tsx` — active file toolbar and renderer selection; renders PDFs through the shared attachment `AttachmentPdfPreview` (official pdf.js viewer components: continuous scroll, selectable text) with loading, too-large, and error/retry states
- `explorer.tsx` — virtualized, searchable file tree
- `source-view.tsx` — lazy read-only Monaco integration
- `source-model-cache.ts` — Scope-isolated Monaco model LRU
- `model.ts` — path, preview classification (including PDF), paging, and title helpers
- `styles.css` — styles scoped to the file workbench

PDF preview bytes come from `GET /workspace/files/content` and are cached in
`context/file.tsx` with a 50 MiB per-file cap and a two-buffer LRU, separate from
the JSON document cache.

The public component boundary is `index.ts`. File data, caching, persistence, and
watcher reconciliation are owned by `context/file.tsx`; all filesystem access goes
through the generated SDK to the current Server Scope.
