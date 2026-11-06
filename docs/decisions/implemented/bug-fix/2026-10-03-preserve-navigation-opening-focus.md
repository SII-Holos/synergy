# Decision Record: Preserve focus chosen while navigation opens

Status: implemented

## Problem

A navigation drawer can receive explicit keyboard focus before its deferred initial autofocus runs. Unconditionally focusing its first control replaces that choice, so the following Tab starts from the wrong control and the drawer remains open instead of returning traversal to the enclosing workspace.

## Decision

WorkspaceNavigator cancels the default delayed autofocus and queues its own initial focus after mounting. It proceeds only while the same drawer is connected and open, the active element has not changed, and focus is still outside the drawer. Initial focus and modal-edge traversal use the same visible, enabled tab stops. Existing dismissal and focus-return ownership remain unchanged.

## Alternatives considered

**Wait longer before the test presses Tab.** This avoids the competing focus assignment in the fixture but leaves fast keyboard or programmatic focus vulnerable in the product.

**Disable initial focus.** This leaves keyboard users at the opener when navigation is opened normally.

## Consequences

Explicit focus choices take precedence over pending entry focus without introducing another timer or persistent state. The rendered regression opens navigation and selects its final control before deferred effects run, then verifies retained focus, Tab dismissal inside the parent modal, Escape and return to the workspace opener. Existing navigation checks continue to cover initial focus, nested menus, outside interaction and reopening.
