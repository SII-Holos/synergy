# Decision Record: Review file actions and inspection-only turn summaries

Status: implemented

## Problem

Review file options opened as a generic popover of buttons. Opening it focused the first action and made it appear selected, and copying a path left the popover open. Its appearance differed from other menus. The conversation's compact file summary also placed Undo beside Review, making an unintended restoration request easy to initiate.

## Decision

File options use the existing Kobalte action-menu primitive and shared MenuField presentation. Pointer opening does not highlight the first item. Keyboard navigation, selection dismissal, overlay ownership and focus return remain part of the menu interaction. Dialog actions close the menu and focus its connected trigger before opening, so dismissal can return to the same file.

Turn summaries expose Review and file navigation without Undo, superseding only the action contract in [compact file change cards](../simplification/2026-10-04-compact-file-change-cards.md). The unused restoration callback is removed across the summary, turn and conversation renderers. Review retains file restoration with the existing preview, current-version validation and confirmation.

## Alternatives considered

**Restyle the generic popover and close individual buttons manually.** This leaves action-menu keyboard and selection behavior to local handlers instead of the established menu primitive.

**Keep the summary Undo button behind another confirmation.** Restoration already requires a preview and confirmation. Removing this shortcut addresses accidental entry while preserving restoration in its dedicated inspection surface.

## Consequences

Menus share existing theme and spacing rules, and successful actions leave a clear completed state. Restoring a turn requires entering Review, trading a shortcut for a less error-prone conversation summary. Browser regressions cover clipboard contents and dismissal, pointer and keyboard focus, dialog return focus, themes, narrow layouts and retained summary states.
