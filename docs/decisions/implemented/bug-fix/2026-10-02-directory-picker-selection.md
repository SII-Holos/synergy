# Decision Record: Separate directory navigation from folder selection

Status: implemented

## Problem

Selecting a folder through the service browser could include directories visited on the way to it. Folder rows toggled selection, while a second action entered the directory. Multi-selection retained the accidental parent choice, which could become the project's main folder and default name.

## Decision

Folder row buttons navigate on click or keyboard activation. Multi-selection uses a separate labeled checkbox or the existing current-folder selection button. Browsing preserves only deliberately chosen paths; single-folder confirmation uses the current directory. The interaction lives in the [directory dialog](../../../../apps/web/src/components/dialog/dialog-select-directory.tsx) and is part of the [Web product rules](../../../../apps/web/PRODUCT.md).

The footer displays deliberately selected folder names beside the confirmation actions, with full paths available on focus and independent deselection. Its list has bounded height so many choices cannot push confirmation out of short windows. Removing a choice transfers focus to the next available control. Folder rows omit trailing navigation arrows, and home, parent and search use quiet shared icon buttons with visible keyboard focus rather than persistent pointer-focus highlighting.

The [browser regression fixture](../../../../apps/web/test/components/dialog/directory-navigation.dom.test.ts) mounts the real dialog, shared controls and styles, checking returned paths through pointer and keyboard interactions, inspectable selections and reachable actions with twenty selected folders in short narrow viewports.

## Alternatives considered

**Filter ancestor paths when confirming.** An ancestor and its descendant can both be intentionally selected. Filtering changes that intent and masks the incorrect first selection instead of fixing it.

**Clear selections on every navigation.** This loses deliberate multi-folder choices made in different directories.

**Keep click-to-select and double-click-to-enter.** Entering a directory can still include the single clicks used to reach it. Separate controls make the two actions explicit and usable through the keyboard.

**Show only a count with paths on hover.** Users cannot inspect or deselect a folder after navigating away from its directory, and hover alone does not serve keyboard or touch users.

**Put an unbounded selection list in the footer.** Large multi-folder selections can consume the dialog's height and hide confirmation. A bounded, scrollable list keeps the final actions reachable.

## Consequences

Browsing to a project does not silently include its parent or give it the parent's name. Multi-folder users retain and inspect explicit selections across navigation. Selecting a folder uses an independent checkbox rather than the folder row, and the existing creation, storage and native picker APIs remain unchanged.
