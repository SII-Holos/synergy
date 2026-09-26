# File Workbench

This directory owns the file workspace UI:

- `content.tsx` — active file toolbar and renderer selection; renders PDFs through the shared attachment `AttachmentPdfPreview` (official pdf.js viewer components: continuous scroll, selectable text) with loading, too-large, and error/retry states
- `explorer.tsx` — virtualized, searchable file tree
- `source-view.tsx` — lazy Monaco editing and draft recovery
- `source-model-cache.ts` — Workspace-generation-isolated Monaco model LRU
- `model.ts` — path, preview classification (including PDF), paging, and title helpers
- `styles.css` — styles scoped to the file workbench

PDF preview bytes come from `GET /workspace/files/content` and are cached in
`context/file/index.tsx` with a 50 MiB per-file cap and a two-buffer LRU, separate from
the JSON document cache. The toolbar Download action points at the raw route with
a `?download=1` query (`GET /workspace/files/raw/{scope}/{workspaceID}/{workspaceGeneration}/{path}?download=1`),
which answers `Content-Disposition: attachment` so any served file type can be
saved to disk.

The public component boundary is `index.ts`. File data, caching, persistence, and
watcher reconciliation are owned by `context/file/index.tsx`; all filesystem access goes
through the generated SDK to the current Server Scope.

Draft recovery preserves unsaved bytes and the original conflict baseline across reloads. Storage failures stay visible and keep the in-memory editor available. Recovered drafts remain in source mode until saved or discarded, including when the original file is missing.
