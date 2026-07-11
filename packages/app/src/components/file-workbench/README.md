# File Workbench

This directory owns the complete read-only file workspace UI:

- `content.tsx` — active file toolbar and renderer selection
- `explorer.tsx` — virtualized, searchable file tree
- `source-view.tsx` — lazy read-only Monaco integration
- `source-model-cache.ts` — Scope-isolated Monaco model LRU
- `model.ts` — path, preview classification, paging, and title helpers
- `styles.css` — styles scoped to the file workbench

The public component boundary is `index.ts`. File data, caching, persistence, and
watcher reconciliation are owned by `context/file.tsx`; all filesystem access goes
through the generated SDK to the current Server Scope.
