# File review

Review is a session-scoped Web workspace panel. Its toolbar selects the comparison source and reports file and line totals. Tool-result review shows the captured result of that individual tool operation.

| Source          | Compared versions                                                   | Mutation                                          |
| --------------- | ------------------------------------------------------------------- | ------------------------------------------------- |
| Turn            | Retained starting and ending snapshots for the selected user turn   | Historical restore after preview and confirmation |
| Session         | Retained net session changes, grouped by captured workspace binding | Historical restore after preview and confirmation |
| Working changes | Git HEAD against staged, unstaged and untracked workspace files     | Read only                                         |
| Branch          | Explicit base and target commit references                          | Read only                                         |

## Presentation

The continuous diff virtualizes files and lines, retains sticky headers and supports per-file or global folding. Automatic layout selects split view at 640 pixels of actual diff width. A 232px directory appears on the right at 800 pixels of panel width; Files opens a directory popover in narrower panes. Quick jump is a separate searchable flat list with basename, directory and workspace labels for duplicate names. Both navigation collections virtualize large comparisons. Arrow keys select, Enter jumps, and Escape returns focus. Navigation filters never remove files from the diff or discard selected lines and content caches.

The reading toolbar orders More, Jump to file, Refresh, Wrap lines, Fold all, Diff layout and Files. Layout opens explicit Auto, Unified and Split choices. Wrap and Files expose persistent pressed states. More contains advanced projections, comments, previous/next navigation, export and available historical restoration. Branch references open a compact editing form. Desktop targets are 32px with 16px glyphs; touch targets are at least 44px and narrow touch panes move Refresh and Fold into More. Wrap and word differences default on. Full files, whitespace display, ignored whitespace and static import folding are optional display projections.

File actions reveal on hover and keyboard focus and remain visible for touch input. Long headers prioritize the basename and expose the complete path through the control's accessible name and tooltip. Recording, loading, empty, error and partial results have distinct states. Refresh and retry retain existing content until successful version revalidation; late responses cannot cross comparison identity. Reading switches preserve the selected file, lines and scroll anchor.

## Versions, notes and export

File versions show captured before/after source and sanitized Markdown, HTML, SVG or supported image previews. Historical reads never substitute the current file. Current-file navigation requires the matching active workspace ID, generation and root.

Viewed markers are manual and apply only to a particular content version. Comments retain a side, original line range, original excerpt and content version. Changed or absent files mark existing comments obsolete. Comments can be edited, resolved, reopened, deleted and explicitly selected for an editable preview before sending to the same conversation.

Patch export and the copied literal `git apply` command use canonical patches, including binary patches. Display filters and folded imports do not modify exported content. The command is copied, never executed by Review. Unavailable or oversized content prevents an incomplete export.

## Resource and authority limits

Git comparisons require an active native workspace and reject stale binding generations, versions and unsafe references. Queries use literal paths and read-only Git metadata operations. File content previews are limited to 1 MiB for retained snapshots and 768 KiB for Git comparisons. Symlinks and submodules have no text preview. At most four file loads run simultaneously; the content cache retains at most 48 files or 24 MiB. Git comparisons are limited to 5,000 files. Review notes use a revision-checked session record with up to 200 comments and 5,000 viewed entries.

Historical restore uses the existing retained authority, versioned preview, confirmation and partial-result workflow documented in [Sessions and messages](../architecture/session-and-messages.md#turn-diffs).
