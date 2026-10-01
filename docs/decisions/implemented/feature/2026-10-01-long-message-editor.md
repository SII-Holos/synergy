# Decision Record: Expand the existing composer for long Markdown instructions

Status: implemented

## Problem

The compact task composer makes long instructions difficult to inspect and format. A separate rich-text editor would introduce a second draft authority and lose native selection and undo history.

## Decision

The built-in Web composer retains one mounted contenteditable editor, the revisioned document service and the existing attachment draft. Expanded presentation fills the available chat area without unmounting the conversation. It defaults to Markdown source, offers an explicit reading view, and shows a live second column at 720 pixels. Preview updates coalesce for 150 milliseconds and pause during input-method composition. Formatting uses revision-checked source edits, including the existing atomic file-reference boundary.

Expanded Enter inserts a line break and Control/Command+Enter submits. Completion and candidate menus handle their keys first; arrows stay in the editor and Escape closes the active composer popup before collapsing. Shell command behavior remains unchanged. An internal acceptance receipt collapses only a still-current, unchanged cleared draft; failed creation, failed submission and later edits preserve the presentation. This adds no Plugin interface or message-schema fields.

Normal editor height starts at 96 pixels and grows within the measured chat height, up to the smaller of 240 pixels and 40 percent. The safe-area and available viewport constrain short windows. The expanded surface leaves side resources and the surrounding navigation available.

A pointer-captured resize separator follows the gesture immediately. Manual height, including composer controls, is bounded by 60 percent of the measured chat area. Dragging a further 32 pixels arms expansion; returning to the height boundary disarms it. Pointer cancellation or Escape restores the previous automatic/manual height. The focusable separator also supports arrows, Home, End and Enter; a size menu offers automatic height, taller editing and expansion without dragging. Pasting, auto-growth and viewport changes never expand the editor.

## Alternatives considered

**A second editor or rich-text document.** This would require synchronizing native editing state, attachment references and a second document representation.

**Expand automatically after a paste.** Size alone is not an intent to switch editing mode, especially under window resizing or a software keyboard.

## Consequences

Long messages gain source formatting and consistent preview while submission, storage and retry retain plain Markdown. The host owns presentation state privately; integrations continue using the existing document API. Task details and inbox placement remain separate work.
