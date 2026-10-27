# File Workbench

This directory owns the file workspace UI:

- `content.tsx` — active file toolbar and renderer selection; renders PDFs through the shared attachment `AttachmentPdfPreview` (official pdf.js viewer components: continuous scroll, selectable text) with loading, too-large, and error/retry states
- `explorer.tsx` — virtualized, searchable file tree
- `entry-actions.tsx` — contextual file commands, inline naming and captured file clipboard operations
- `entry-dialog.tsx` — version-aware permanent-delete confirmation
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

The single file toolbar uses the shared `MenuField` for captured Workspace origins, with short trigger labels and complete path options. Parent-directory navigation does not repeat the basename already shown by the resource tab. Origin changes open a directory resource through the normal close policy instead of retargeting an existing document. The shared `WorkspaceNavigator` owns both wide resizing and the resource-local narrow drawer.

The toolbar stays in one row: origin text takes the remaining width, compact layouts reduce gaps and action text, and parent-directory links appear only when the location area has room. Source/Preview and editing controls retain their labeled semantics and minimum hit areas rather than wrapping or clipping out of reach.

File creation and F2 rename use focused inline inputs in the virtual tree; Enter confirms and Escape outside IME composition cancels. Context menus and tree shortcuts expose cut, copy, paste, relative-path copy and permanent deletion. The FileProvider manager retains an in-memory clipboard across file-panel remounts, with a captured server/Scope/Workspace-generation key and observed entry version. Paste requires the same owner; successful moves consume the clipboard, copies remain reusable, and server-side collisions never overwrite an existing entry. Permanent deletion has a dedicated confirmation and preserves unsaved drafts at their original paths.

Source wrapping defaults on, persists per file with the existing session view state, and updates the current Monaco editor without changing bytes, drafts, models, selection or undo history. The toolbar and owner-scoped Alt+Z toggle it only in source mode. See the [layout and action decision](../../../../../docs/decisions/implemented/feature/2026-10-26-file-workbench-toolbar-and-context-actions.md).

Source-loader failures remain local to the viewer, clear the rejected shared promise and offer Retry without discarding drafts or taking focus. The error also explains page reload for browser-cached module evaluation failures. Disposed viewers ignore late loader completion and rejection.

The Explorer header toggles all folders with the same fold/unfold icons as Review, without a tooltip. Explicit expansion reads directory pages recursively through the existing concurrency-limited loader and skips symbolic-link traversal. Collapse, manual folder toggles, filter changes, and Explorer disposal stop further expansion; late reads cannot reopen folders. Unreadable branches retain their retry state while other branches continue.
