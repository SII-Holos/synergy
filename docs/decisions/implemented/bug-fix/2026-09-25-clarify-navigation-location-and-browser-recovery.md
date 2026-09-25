# Decision Record: Clarify navigation, working location and browser recovery

Status: implemented

## Problem

Recent conversations and project trees competed within one navigation list, mobile tools lacked modal focus ownership, and the session header could suggest the project directory even when execution used a different Workspace. Dense recurring agenda entries obscured individual tasks. Browser Retry could reconnect presentation without restoring the server's existing page after a restart.

## Decision

Separate Recent and Projects with keyboard-operable tabs on desktop and mobile. Keep tools and identity outside the collection scroller. Preserve HOLOS as the primary identity, identify the Synergy workbench separately and label the account surface explicitly. Keep Agent, model and permissions visible on narrow Composer layouts; group the existing Add actions without changing their execution.

Use the shared modal stack for both mobile drawers, including settings opened above a drawer. Escape closes one layer, focus returns to its entry and widening to desktop releases the modal. Derive the working-location summary from the current session binding or explicit new-session selection. A missing or invalid binding never inherits the project directory, and a requested worktree remains pending until creation. Workspace selection retains its existing revision, sharing and idle-state checks.

Show agenda series as the default schedule view, with expandable bounded planned-time previews and canonical last-failure/pending filters. Retain day/week/month and execution history; missing run metadata stays unknown. Calendar navigation advances local calendar dates across daylight-saving boundaries. Catalog rows emphasize author-provided purpose, source and installation status, with technical metadata in plugin details and existing disabled errors visible.

For remote Browser recovery, read the current server state, validate its owner and existing page, resume an active page that needs recovery or a retained page in failed state, then reconnect the events socket and viewer. Keep intentionally suspended pages passive. Coalesce repeated attempts and cancel on unmount. Ignore callbacks from replaced sockets. Preserve the address and diagnostics during failure; do not create a new page or replay navigation and form actions.

The desktop category arrangement is refined by [preserving sidebar collection categories](2026-09-25-preserve-sidebar-collection-categories.md).

## Alternatives considered

**Infer execution location from the project.** Scope identity does not determine the selected Workspace, and a null selection is meaningful.

**Flatten recurring events into the primary list.** High-frequency tasks dominate the view; series grouping preserves detail without changing the scheduler.

**Retry only the viewer connection.** Presentation cannot recover a persisted page whose server runtime has not resumed. Blindly navigating the last URL could replay actions and violate page ownership.

## Consequences

Drawer browser tests exercise focus containment, nested Escape, focus return and desktop resizing. Location tests cover explicit none, unavailable bindings and pending worktrees. Agenda tests cover grouped occurrences, missing metadata, filters and daylight-saving dates. Browser recovery tests cover read/resume/reconnect ordering, failed restart checkpoints, suspended pages, ownership rejection, duplicate attempts, cancellation, stale sockets and viewer remounts. Product strings use the shared reactive localization catalogs.
