# Decision Record: Workspace presentation ownership and empty resource tabs

Status: implemented

## Problem

The resource strip placed creation controls in its scrolling region and shared visibility with an outer session toggle. Empty tabs used singleton registration, so repeated creation appeared unresponsive. Fullscreen changed the resource positioning while the conversation Composer and collapsed navigation still painted above it. Restoring split layout could temporarily exceed the container width.

## Decision

The built-in Session owns the closed Workspace entry; the open resource strip owns collapse and presentation controls. Only document tabs scroll. An explicit new tab creates an independent empty slot, and choosing a resource fills that captured slot. Resource deduplication and document save protection retain their existing owners. A delayed request checks that the empty slot still exists before modifying the layout.

The side surface is anchored to the right within the built-in Session. Its width and the conversation margin use the shared structural transition. Fullscreen hides and makes the retained conversation and built-in navigation inert while preserving drafts and preferred sizes. Restore and fullscreen use paired size glyphs, and the empty view presents only available primary resource types.

## Alternatives considered

**Increasing only the overlay z-index.** This would leave hidden conversation and navigation controls in the focus order and keep competing collapse controls. Presentation ownership addresses painting, hit testing and focus together.

**Reusing the empty view as a singleton.** This makes an explicit creation action appear to do nothing and retains intermediate index tabs. Independent slots allow deliberate parallel resources while ordinary document navigation still replaces the current document through its close policy.

## Consequences

The built-in Shell gains presentation rules for its own navigation and Session composition. Third-party Shells keep their existing public UI contracts. Tests exercise resource identity, composed fullscreen behavior, narrow overflow and retained drafts; visual acceptance still uses the full product page. This refines the [resource workspace decision](../architecture/2026-10-01-resource-workspace-and-project-browser.md).
