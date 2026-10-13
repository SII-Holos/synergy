# Decision Record: Inbox detail actions

Status: implemented

## Problem

Compact Inbox details repeat the row's promotion, retry and removal controls. The duplicated action area distracts from reading, while the row action hover matches its surrounding highlight. Detail content also carries a width independent of its popover, allowing text to extend beyond the visible surface.

## Decision

Inbox actions belong to their original row and remain available while its detail is open. The detail contains only content, failure information and delivery metadata. Its popover owns width; content wraps and scrolls within the available viewport. This refines the Inbox presentation in [compact task details](2026-10-04-compact-task-details.md) without changing queue scheduling or recovery.

Task-detail icon actions and Workspace creation segments use a stronger canonical surface for individual hover and keyboard focus, with a further surface step for a held press. Group highlights, segment geometry and focus outlines remain independent. Reduced motion removes the action transitions.

## Alternatives considered

**Keep equivalent controls inside the detail.** This offers a second location for the same actions while consuming reading space and creating another focus stop. The original row is already retained and exposes its controls while the detail is open.

**Change only icon color on hover.** Small glyph changes provide little feedback inside a highlighted row. A distinct surface identifies the complete hit area using the existing theme palette.

## Consequences

The detail is smaller and each action has a visible target in light and dark themes. Keyboard users return to the row to change delivery or remove a message. Browser coverage checks single action ownership, local hover and press feedback, focus return, recovery and content bounds on narrow screens.
