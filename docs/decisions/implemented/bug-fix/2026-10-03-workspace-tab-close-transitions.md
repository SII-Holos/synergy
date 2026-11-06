# Decision Record: Atomic Workspace tab closure and independent close controls

Status: implemented

## Problem

Closing an active resource exposed a transient missing selection to Workspace restoration, which created extra empty tabs. The close button also shared its hover surface with the tab and admitted the tab's pointer drag sensor, making close feedback indistinct and held clicks unreliable.

## Decision

Workbench applies tab collections, active identity and surface visibility in one Solid batch for opening and accepted closing. Restoration sees the settled resource selection. Existing domain save protections and captured Session/resource checks remain authoritative. Closing the final resource leaves an empty, collapsed surface; surviving resources retain the established neighbor-selection policy.

The close button uses a stronger semantic hover surface and stops pointer-down propagation with a direct listener before the ancestor drag activator. The tab body retains sorting. Full-title hints belong to the tab selection button rather than its close control.

## Alternatives considered

**Suppressing restoration with a temporary closing flag.** This adds a second presentation state and special handling for each asynchronous close path. Atomic publication also prevents intermediate restoration during resource opening.

**Stopping pointer propagation in a delegated handler.** Solid's delegated listener runs after the ancestor's native drag listener, so it cannot prevent activation. Disabling tab dragging entirely would remove a supported interaction.

## Consequences

The shared side and bottom resource shells retain their lifecycle and save behavior. Browser and plugin resource cleanup hooks keep their existing contracts. Rendered regressions verify complete tab collections, final collapse, active/inactive selection, pending and cancelled protection, concurrent closure, Session ownership, drag isolation and both hover themes.
