# Decision Record: Resize the shared conversation column

Status: implemented

## Problem

A fixed reading width leaves unused horizontal space and prevents users from expanding long conversation text and the input together.

## Decision

The built-in session layout exposes a right-edge width handle for the shared conversation and Composer column. The existing connection-local layout preference owns its width. Pointer dragging accounts for the centered column; keyboard controls and double-click provide equivalent adjustment and reset. Narrow panes constrain the visible width without overwriting the saved preference.

## Alternatives considered

**Resize only the input.** This leaves conversation text constrained and breaks the shared reading alignment.

**Always fill the pane.** This removes the compact reading width preferred for ordinary prose.

## Consequences

Users can choose a comfortable reading width without changing drafts or text size. The built-in layout carries an additional control; third-party session layouts retain their own layout ownership.
