# Decision Record: Exclude hidden workspace focus targets

Status: implemented

## Problem

Workspace tab menus keep hidden positioning anchors with layout rectangles. Checking rectangles and tabIndex alone admits these anchors into custom Tab traversal. When an earlier resource tab is inactive, wrapping focus or leaving a navigation drawer can select its invisible anchor and leave focus on the page body.

## Decision

WorkbenchSurface and WorkspaceNavigator share one internal tab-stop query that also requires computed visibility to be visible. Both forward and reverse traversal use that query; menu anchoring and native tab semantics remain unchanged. No new public interface or stored state is introduced.

## Alternatives considered

**Special-case menu anchors in each focus handler.** This duplicates knowledge of another component's markup and leaves other hidden controls vulnerable.

**Remove positioning anchors.** Anchors still serve controlled context-menu positioning; replacing that mechanism is unrelated to focus traversal.

## Consequences

Focus stays on visible workspace controls. Rendered regressions activate a later resource tab and exercise forward and reverse wrapping, nested drawer dismissal, Escape and return to the modal opener through the real WorkbenchSurface.
