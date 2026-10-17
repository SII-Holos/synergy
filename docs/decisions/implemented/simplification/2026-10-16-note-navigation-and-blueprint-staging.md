# Decision Record: Unified Note navigation and Blueprint staging

Status: implemented

## Problem

Notes used separate list-home and editor navigation trees. The home stretched document rows across a wide Workspace, repeated creation actions on each Scope and gave Blueprints redundant kind captions. The execution-agent picker repeated its heading and nested padding. Blueprint drops were rejected by stale terminal bindings and busy ordinary Sessions; failed workflow responses could still stage a Blueprint, obscuring whether binding succeeded.

## Decision

Notes use one compact Workspace navigator beside the existing retained document reader. Its single create menu selects an active Scope. Kind icons identify documents, while active and terminal Blueprint states retain accessible compact indicators. Narrow list homes render inline; selected documents use the shared focus-contained navigation drawer. Metadata filters do not remove the current editor. The execution-agent picker uses one heading and the available width.

The shared navigator retains its last visible layout while its view is inactive. Hidden geometry cannot unmount the inline navigation tree. Inactive views release resize observers and close transient drawers; reactivation measures the current container before adjusting presentation. Keyboard ownership and selection remain with the retained panel.

Blueprint drops replace idle Plan or Light Loop and stage a pending row with the Note title and a short ready status. This preserves the user’s binding intent while deferring Blueprint creation and start to submission. Running workflows remain protected by the existing idle requirement; ordinary busy Sessions may stage a Blueprint for later. Failed, stale or duplicate transitions cannot overwrite the current Composer. Removing the pending row makes no request. The existing submission owner creates and starts the Blueprint only when submitted from an idle Session. Busy submission stays blocked while the normal stop action remains available. Ordinary Note drops retain their reference-attachment behavior.

## Alternatives considered

**Keep separate list and reader navigation.** Both trees would still need identical creation, filtering, status and drag behavior, with divergent widths and affordances already causing inconsistencies.

**Keep per-Scope creation actions.** Repeated buttons add visual weight and stretch rows without improving access over one explicit destination menu.

**Start on drop.** The user has not yet sent the instructions to run with the Blueprint.

**Defer all workflow changes until submission.** This leaves the previous Plan or Light Loop active after the user deliberately binds a Blueprint, so binding no longer reflects the selected intent.

## Consequences

Navigation occupies a bounded part of wide Workspaces and yields the full reader width when hidden. Fullscreen does not stretch the list. Creating a Note now includes choosing its destination. Existing execution or review disables the Blueprint run action. Tests cover actual drag events, zero execution requests during binding, failed/stale transitions, independent binding after changing Sessions, busy/idle submission intent, narrow focus return, picker geometry and preserved editor state. The change adds no storage format, event subscription, polling or full-body reads.
