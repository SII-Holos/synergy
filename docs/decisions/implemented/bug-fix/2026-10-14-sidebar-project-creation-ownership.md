# Decision Record: Sidebar project creation ownership

Status: implemented

## Problem

The sidebar and Composer project selector share `project.create`. The newest command registration wins, so the selector's disabled or attachment-uploading state can block the enabled sidebar Add project button. Its creation callback also carries task-specific draft transfer that does not belong to global project navigation.

## Decision

Layout passes its global project creation handler through LayoutContent to Sidebar. Add project invokes that handler directly and appears only while the connected service advertises Workbench. Composer menu and command creation retain their task-specific draft transfer and disabled states. Global command precedence remains unchanged.

The [sidebar browser regression](../../../../apps/web/test/components/sidebar/sidebar-collections.dom.test.tsx) mounts the real task selector and command registry alongside Sidebar, verifies project creation for disabled, uploading and enabled selectors, and retains independent disclosure state. Core-only navigation exposes no unsupported creation action.

## Alternatives considered

**Ignore disabled command overrides.** This would execute another registration when the selected command intentionally blocks an operation, changing command semantics beyond project creation.

**Remove the Composer creation command.** This would remove its draft-preserving task entry behavior from the command palette.

## Consequences

Sidebar creation stays independent of task state and leaves the source task draft with its existing owner. The same form and capability guard remain owned by Layout; Composer creation continues to select the destination through its revisioned draft transfer. Sidebar callers must provide the global creation handler.
