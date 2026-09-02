# Decision Record: File explorer restores persisted expanded folders on mount

Status: implemented

## Problem

The workspace Files panel's expanded-folder list (`file-explorer.expanded`) is persisted to workspace-level localStorage through `Persist.workspace`, while the tree's node and directory caches (`context/file.tsx` `store.nodes` / `store.directories`) live only inside the `FileProvider` context. Navigating between sessions that cross Scope boundaries unmounts the whole directory layout's `<Show keyed>` branch, recreating `FileProvider` with a clean tree store; the `FileExplorer` mount hook populated only the root directory that was previously shown to the user. The next panel painted the tree with `expanded(path) === true` for the persisted folders but an empty child list, so every re-opened folder looked collapsed. Toggling a row flipped the stale `expanded` flag first (true → false) and only the second click both flipped it back and triggered `loadChildren`, which made folders appear to need two clicks to expand.

## Decision

`FileExplorer` mounts also walk `file.explorer.expanded()` and call `loadChildren(path)` for each persisted folder, alongside the existing root `loadChildren("")`. The calls reuse the directory cache's existing fast paths (`complete && !stale` returns a no-op), so a folder whose children are already warm in the new provider does not make another request. The fix stays in `explorer.tsx`; `context/file.tsx` keeps expansion state as the persisted source of truth.

## Alternatives considered

**Persist the tree cache too** — writing `store.nodes` / `store.directories` into localStorage would have restored rendering without any new fetch, but cached entries become untrustworthy the moment an internal or external edit changes the tree, and rehydrating stale nodes through reconcile would re-introduce the same stale-tree bug we were just fixing.

**Restore lazily on first paint of a persisted row** — waiting until the `rows` memo hit an expanded-but-uncached folder would avoid eager loads for folders the user no longer cares about, but it complicates the memo and keeps the broken first paint visible; the persisted list is already bounded (user-expanded folders only), so eager restore is cheap.

**Skip the fix and rely on manual refresh** — the refresh button and window-focus handler already run `refresh()`, which reloads every expanded folder. Rejected because it makes a core panel interaction (switching away and back) require an extra corrective action and leaves the UI in a half-open state.

## Consequences

Switching sessions or Scopes no longer requires folders to be re-opened one by one; the tree paints its persisted expansion in the first render after `FileExplorer` mounts. The change adds at most one extra `loadChildren` request per persisted folder on mount, which hits the same pagination and abort-semantics as the existing expand flow. The `explorer-restore.dom.test.ts` Playwright fixture pins the regression by constructing a stub file model with persisted `expanded = ["docs"]` and an empty in-memory tree, then asserting the subtree renders.
