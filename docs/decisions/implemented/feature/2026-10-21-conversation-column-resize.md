# Decision Record: Resize the shared conversation column

Status: implemented

## Problem

A fixed reading width leaves unused horizontal space and prevents users from expanding long conversation text and the input together.

## Decision

The built-in session layout exposes a right-edge width handle for the shared conversation and Composer column. The existing connection-local layout preference owns its width. Conversation prose includes the same inner text inset as the Composer editor, placeholder and completion overlay; aligning only their outer containers left the prose visibly offset during resizing. The host sets the shared SessionTurn reading-width contract so text, reasoning and completion footers follow the resized column; the shared component’s default 54rem cap otherwise creates a second centered column on wide layouts. Pointer dragging accounts for the centered column; keyboard controls and double-click provide equivalent adjustment and reset. Narrow panes constrain the visible width without overwriting the saved preference, including when a constrained drag is cancelled. Layout migration retains the preference across reloads and upgrades. The column handle stays inside its gutter so the workbench divider keeps its pointer target; End uses the actual pane width on ultrawide displays.

## Alternatives considered

**Resize only the input.** This leaves conversation text constrained and breaks the shared reading alignment.

**Always fill the pane.** This removes the compact reading width preferred for ordinary prose.

## Consequences

Users can choose a comfortable reading width without changing drafts or text size. The built-in layout carries an additional control; third-party session layouts retain their own layout ownership.
