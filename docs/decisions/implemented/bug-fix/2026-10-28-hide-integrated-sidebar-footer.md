# Decision Record: Hide the integrated sidebar footer on collapse

Status: implemented

## Problem

The built-in sidebar collapses to zero width, but an independently positioned Personal space footer overlaps the conversation. A standalone control test cannot distinguish this hidden sidebar from a visible compact navigation rail.

## Decision

The integrated Sidebar mounts its footer only while expanded, disposing the space trigger and any portalled menu together. Reopening creates a closed, usable menu. Standalone compact navigation and the mobile drawer retain their existing space controls. This supersedes only the collapsed-footer visibility choice in [centralized identity retirement](../simplification/2026-10-26-retire-centralized-identity.md).

## Alternatives considered

**Hide only the footer with CSS.** An open menu is portalled outside the footer and can survive its hidden trigger. Conditional ownership removes both surfaces together.

**Remove the compact SpaceSwitcher presentation everywhere.** A standalone sidebar still occupies a visible navigation rail. Its compact control and the separate mobile drawer do not cause the overlap.

## Consequences

Built-in navigation must be expanded to reach Personal space. The existing composed Sidebar browser test checks an open menu through collapse, footer removal, keyboard reopening and settings access; shared control tests retain compact placement and narrow-screen behavior.
