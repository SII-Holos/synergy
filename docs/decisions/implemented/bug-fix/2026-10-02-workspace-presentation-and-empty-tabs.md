# Decision Record: Workspace presentation ownership and empty resource tabs

Status: implemented

## Problem

The resource strip placed creation controls in its scrolling region and shared visibility with an outer session toggle. Empty tabs used singleton registration, so repeated creation appeared unresponsive. Fullscreen changed the resource positioning while the conversation Composer and collapsed navigation still painted above it. A left overlay inset overrode the right anchor during width interpolation, reversing expansion and displacing controls. The closed entry and open collapse control also differed in bounds and glyph size, and their flex row overflowed toward the right during narrow opening frames. The portaled entry's reserved space exceeded the ordinary toolbar gap. Restoring split layout could temporarily exceed the container width.

## Decision

The built-in Session owns the closed Workspace entry; the open resource strip owns collapse and presentation controls. Only document tabs scroll. An explicit new tab creates an independent empty slot, and choosing a resource fills that captured slot. Resource deduplication and document save protection retain their existing owners. A delayed request checks that the empty slot still exists before modifying the layout. Panel mount identity includes the tab and panel type, so filling an empty slot mounts the chosen implementation while metadata updates within a resource retain their controller.

Document navigation uses compact Scope groups with secondary list actions in a text menu. The document title and body use the same reading measure. Files keep the filename and edit/view controls visible while secondary actions use a menu. Navigation stays mounted when Notes switch documents. Disclosure reports actual drawer visibility and returns focus to a replaced document trigger, and the child Explorer owns its only visible drawer heading and close action. Restored editor mounts initialize the new formatting element as hidden before reusing the retained editor, preserving selection and undo without exposing an unpositioned toolbar.

The side surface is anchored to the right within the built-in Session. Its width and the conversation margin use the shared structural transition. The overlay keeps a right anchor without a competing left inset, and the resource strip aligns overflowing controls to the right during narrow intermediate frames. The closed entry shares the collapse control's dimensions, inset and glyph size. Session toolbar actions use compact glyphs while retaining their hit areas, and the portaled entry reserves only its width, right inset and the ordinary action gap. Fullscreen hides and makes the retained conversation and built-in navigation inert through the plugin container, respects the native titlebar safe area while preserving drafts and preferred sizes. Restore and fullscreen use paired size glyphs, and the empty view presents only available primary resource types.

Local presentation state is initialized before eager reactive projections read it. A fresh mount with multiple restored tabs exercises the overflow menu immediately, including when resizing changes the Session layout; restoration must not depend on the empty or single-tab startup path.

Files keep the navigation disclosure identity tied to the resource tab while each document controller retains its own mount. Closing the drawer after choosing another file can therefore return focus to the replacement document's disclosure instead of the page body.

An explicit new tab or an already-open target may replace the disclosure's tab identity. The drawer restores focus to the active resource's visible navigation control within its Workspace host, excluding hidden or inert controls. Drawer bounds follow the resource content, so a narrow split pane opens navigation at its own edge rather than the window's left edge.

The built-in Shell's full width and its normal navigation preference determine available split space. Expansion occupies the complete Shell width. Its breakpoint must not depend on the expanded Session's measured bounds or hidden navigation occupancy, which would repeatedly alternate between expansion and split layout.

Creation controls separate the group's control surface from the individual segment's hover surface. An open resource menu retains its segment state after focus moves into the popup. Pointer focus on the other segment does not hold its highlight; keyboard focus remains visible. Fullscreen uses diagonal outward arrows and the shared restore action uses diagonal inward arrows, with Full screen and Exit full screen labels.

## Alternatives considered

**Increasing only the overlay z-index.** This would leave hidden conversation and navigation controls in the focus order and keep competing collapse controls. Presentation ownership addresses painting, hit testing and focus together.

**Reusing the empty view as a singleton.** This makes an explicit creation action appear to do nothing and retains intermediate index tabs. Independent slots allow deliberate parallel resources while ordinary document navigation still replaces the current document through its close policy.

## Consequences

The built-in Shell gains presentation rules for its own navigation and Session composition. Third-party Shells keep their existing public UI contracts. Tests exercise resource identity, composed fullscreen behavior, narrow overflow and retained drafts. The actual Session toolbar verifies adjacent action spacing, rendered SVG size and keyboard entry/return, including narrow Session columns. Frame sampling verifies the expansion direction and stationary controls through opening, fullscreen and restore under normal and reduced motion; endpoint geometry alone cannot establish these properties. Visual acceptance still uses the full product page. This refines the [resource workspace decision](../architecture/2026-10-01-resource-workspace-and-project-browser.md).
