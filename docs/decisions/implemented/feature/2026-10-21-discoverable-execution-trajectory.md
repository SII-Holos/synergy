# Decision Record: Expose execution trajectory from the conversation

Status: implemented

## Problem

Execution evidence includes multi-turn inputs, model requests, context sources and tool results, but users must discover it inside a secondary task-details menu and context dashboard.

## Decision

The conversation header exposes a labeled Trajectory action and the workbench launcher exposes an Execution trajectory entry. Both open a lazy session-scoped singleton using the existing execution panel, paged event projection and read-only inspector. The panel starts with all recorded events across the task tree. Task details, including Kanban's compact task view, open the same trajectory through their full-trajectory action. The context dashboard remains available for context composition and token analysis.

## Alternatives considered

**Move all evidence into Kanban.** Debugging would require leaving the active conversation and duplicate the session inspector.

**Build another trace store and renderer.** This would diverge from canonical recording, pagination, cancellation and content-verification behavior.

## Consequences

Users can inspect recorded system/context sources, user and assistant content, model requests and tool results from their current conversation. Existing historical gaps remain explicit; presentation cannot reconstruct evidence that was never recorded. The header gains one action, reduced to its icon on narrow screens.
