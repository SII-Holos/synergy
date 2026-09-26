# Decision Record: Scope workspace keyboard and recovery

Status: implemented

## Problem

Nested interactive trigger wrappers created duplicate tab stops, sidebar pseudo-buttons lacked native activation, hidden workspaces stayed focusable, and document-level Escape listeners collapsed sibling surfaces. BottomSpace used the trailing resize edge. Runtime panel errors and mobile workspace overlays lacked local recovery or modal focus ownership.

## Decision

Sidebar disclosures and toolbar selectors expose one native button with expanded-state metadata. Retained workspaces become inert and aria-hidden when collapsed, preserve their mounted state, and return focus to their opener when they contained focus.

Workbench Escape handling runs after inner controls and respects prevented events, active dialogs, open menus and editable targets. Only the workspace containing the event target may collapse. Shared overlays own their own dismissal rather than a global menu registry closing unrelated surfaces.

BottomSpace uses its top edge for both pointer and keyboard resizing. Runtime ErrorBoundary recovery resets only its failed panel and exposes collapsed diagnostic details. Mobile workspaces use the shared modal stack; presentation disposal does not close the underlying workspace when switching responsive layouts.

## Alternatives considered

**Unmount hidden panels.** This removes focus targets but also discards retained local state and drafts.

**Stop every document listener from the first surface.** This arbitrarily chooses a sibling and prevents inner overlays or editable controls from owning Escape. Event ownership follows the focused surface instead.

**Reload the App after a panel error.** A local boundary reset recovers the failed renderer without discarding sibling state or navigation.

## Consequences

Native activation and shared modal behavior reduce local keyboard code. Browser regressions cover retained input, two open workspaces, nested dismissal, top-edge resizing, sibling-preserving retry, responsive modal cleanup and single-stop Tooltip triggers.
