# Decision Record: Close other workbench tabs from toolbar and tab context menu

Status: implemented

## Problem

Multi-cardinality workbench panels (Files, Browser, Terminal, plugin panels) accumulate one tab per opened resource in the side and bottom workbench surfaces. Once a dozen file tabs are open, closing them is strictly one-by-one — each close button is hover-only and small, and the middle-click shortcut is not discoverable. There was no bulk-close action anywhere in the tab run.

## Decision

Add a "Close other tabs" action in two entry points, both operating on the workbench tab model:

- `closeOtherWorkbenchPanelTabs(tabs, active, keepTabId)` in `packages/app/src/context/workbench/panel-model.ts` computes the retained `[keep]` tab list and activates the kept tab, mirroring the `(tabs, active, tabId)` signature of `closeWorkbenchPanelTab`. A missing kept tab is a no-op that returns the input unchanged, so a stale call after an async cleanup window cannot activate a nonexistent id.
- `useWorkbenchPanels().closeOtherTabs(keepTabId)` locates the surface owning the kept tab and `closeOtherTabsOnSurface(surfaceName, keepTabId)` awaits every closed tab's `entry.onCloseTab` hook (terminal pty removal, browser page teardown, plugin cleanup) before committing one atomic `setTabs`/`setActive` store update. The single-tab `closeGuard` is deliberately not used here: it prevents re-entrant Solid double-disposal for the same tab, whereas concurrent close-others invocations target disjoint keep sets.
- Toolbar entry: an `action.more` (⋯) `IconButton` sits beside the add-panel (+) button in the tab run, visible only when more than one tab is open, opening a Popover with "Close other tabs" for the active tab.
- Context-menu entry: right-clicking any tab header opens a Popover anchored to that tab (hidden zero-size trigger overlaid on the tab via `position: absolute; inset: 0; visibility: hidden`) with "Close {title}" and "Close other tabs", acting on the right-clicked tab without requiring prior activation. The opened tab gets a `workbench-surface-tab--context` hover-equivalent highlight while its menu is open. Single-tab surfaces render the item disabled rather than hiding it.
- New copy (`app.workspace.tab.actions`, `app.workspace.tab.contextMenu`, `app.workspace.tab.closeOthers`) ships with zh-CN translations.

## Alternatives considered

- **Toolbar-only entry** — rejected: the user's stated workflow is closing specific clusters of file tabs, and acting on the right-clicked tab directly matches every editor's tab bar convention (VS Code, browsers). Both entries share the same context methods, so the second surface costs almost nothing.
- **"Close all tabs" item as well** — rejected for now: closing every tab reopens the launcher (the surface auto-closes on zero tabs), which is rarely the intent behind tidying up; "close others" covers the real workflow. The model function generalizes if a close-all item is later wanted.
- **A generic context-menu UI primitive in `packages/ui`** — rejected: this is the first right-click menu in the product; the existing Popover component covers the interaction, and promoting a primitive from a single use would be speculative abstraction.
- **Reusing `createTabCloseGuard` for the batch close** — rejected: the guard's contract is per-tab re-entrancy during a single close; repurposing it for set semantics would blur why it exists. Interleaved batch closes converge on the same final state because each commits current store state after its cleanups.

## Consequences

Both entries appear on the bottom surface too (Command Output tabs get the same actions for free, since the tab model is shared). Async `onCloseTab` hooks run sequentially for the closed tabs, so closing many terminal tabs takes one network round-trip per pty; the surface stays consistent throughout because the store update is committed once at the end. Right-click on the toolbar buttons still falls through to the browser default menu; only tab headers intercept `contextmenu`.
