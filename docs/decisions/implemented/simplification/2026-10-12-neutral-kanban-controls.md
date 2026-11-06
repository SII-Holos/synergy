# Decision Record: Neutral Kanban headers and conversation controls

Status: implemented

## Problem

Kanban paints whole session headers by status and uses filled form controls inside each composer. The repeated color bands and grey fields give the board a different visual hierarchy from the main conversation, where the input shares one surface with a quiet toolbar.

## Decision

Kanban headers and composers use the same semantic input surface as the main conversation. Session state stays in its existing icon and text, with the same resolved status and unread-completion semantics. Header backgrounds and separators remain neutral across working, waiting and completed states. This supersedes the [header tint decision](../../archived/feature/2026-09-08-kanban-pane-status-tint.md).

The plain text input sits above its choices, without a separate fill or border. Agent, permission, workflow and grid-dimension selectors keep the shared MenuField behavior with transparent resting triggers. Header actions use foreground emphasis for their pressed state. Sending uses the same primary circular IconButton and upward-arrow meaning as the main conversation. Input appearance remains unchanged during hover, pointer press and focus.

## Alternatives considered

**Reducing the status tint strength** preserves the full-width status color and the difference from the main conversation; the existing icon and status text already carry that information.

**Changing the shared MenuField default** alters unrelated forms. Kanban supplies its existing host classes and theme variables while retaining shared menu selection, keyboard and focus behavior.

## Consequences

The board and main conversation share the same surface hierarchy in both themes. Full-width color scanning is replaced by readable status labels and icons. Draft ownership, permission changes, workflow selection, send failure recovery and responsive layout remain intact. Browser regressions compare the rendered surfaces with the main composer styles, cover input interaction states, and verify narrow controls and retained drafts.
