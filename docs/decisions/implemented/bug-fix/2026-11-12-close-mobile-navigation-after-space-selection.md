# Decision Record: Close mobile navigation after Space selection

Status: implemented

## Problem

Selecting Personal space from mobile navigation restored its original draft behind an open modal drawer. Other navigation items close that same drawer after selecting their destination. Space selection had no way to complete the mobile shell's navigation lifecycle, so the destination remained blocked until a second manual close.

## Decision

SpaceSwitcher accepts an optional navigation callback and invokes it after its existing Personal space, organization and connect actions. The mobile drawer supplies its existing close callback. Desktop and organization-page consumers retain their existing behavior without supplying that callback. Space identity, routing, draft ownership and permission checks remain in their original owners.

## Alternatives considered

**Close the drawer through a global route effect.** This would couple every route change, including unrelated callbacks, to mobile presentation instead of completing the action that owns the navigation.

**Close it manually in the test.** This demonstrates retained data but misses the blocked destination after the user's original Space selection.

## Consequences

The combined full-App browser test waits for Navigation to disappear after selecting a Space and focuses the restored composer through a real click. Its mobile capture shows the usable destination without an extra dismissal. The optional callback adds no new navigation or resource-panel entry point.
