# Decision Record: Workspace menus over native Browser

Status: implemented

## Problem

Workspace resource and tab menus can extend into a Browser page. The native view only observes Browser-local controls and application dialogs, so it continues drawing above those Workspace menus and intercepting their input.

## Decision

Each Workspace surface supplies its rendered resource, tab context and overflow menu visibility through a local reactive context to its panel. Native Browser presentation includes that signal in its existing blocker calculation. Menus that leave the rendered surface no longer block the page.

The existing Desktop visibility transition retains the same native page and may supply a bounded still image behind the menu. Closing a menu restores live presentation only after every other blocker closes. Page ownership, profile partitions, login state and native protocols are unchanged.

## Alternatives considered

**Raise the menu's CSS stacking level.** Rejected because the native page is a separate Electron view outside the renderer's CSS stacking order.

**Detach or recreate the page when a menu opens.** Rejected because the existing visibility mechanism preserves the page and its in-memory state without changing its lifetime.

**Track every application popover globally.** Rejected for this defect because the Workspace already owns these menu states; a local context avoids hiding the page for unrelated surfaces or adding Browser concerns to shared UI primitives.

## Consequences

Workspace menus can cover and receive input above the native Browser without duplicating menu state inside the Browser store. Newly introduced Workspace menus must participate in the owning surface's visibility signal. Rendered regressions exercise resource, context and overflow menus at narrow and wide widths, keyboard dismissal and focus return, overlapping page errors, still-cover cleanup and preservation of the original native page.

This completes the Workspace portion of the blocker contract described in [Browser runtime](../../../architecture/browser-runtime.md) and [Browser workspace](../../../product/browser.md).
