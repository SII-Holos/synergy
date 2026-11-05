# Decision Record: Wait for image menu focus before keyboard input

Status: implemented

## Problem

An image action menu can be visible while its initial focus is still pending. Focusing a checkbox item before that work finishes allows the pending focus to redirect Space to the menu container. The command does not run, so a test waiting for menu dismissal reports a failure unrelated to its intended selection assertion.

## Decision

Image viewer browser tests observe focus inside the current menu before sending Space, Enter or Escape. Each newly opened context, overflow or fullscreen menu establishes this readiness independently. Existing assertions still require checkbox state changes, menu dismissal, preserved parent dialogs, source-pixel zoom and restored focus.

A controlled browser probe holds the real menu's initial focus and releases it between item focus and Space. The key reaches the menu container and leaves the grid selected. Releasing initial focus before selecting the item sends Space to the checkbox, toggles the grid and closes only the menu. This distinguishes missing test readiness from product behavior without changing the component or its focus lifecycle. The owning [browser fixture guidance](../../../../.synergy/skill/develop-frontend/references/browser-fixtures.md) defines the reusable readiness rule.

## Alternatives considered

**Retry the test or extend its timeout.** Neither establishes which element receives the key, and a command that never ran cannot finish through a longer dismissal wait.

**Change production focus or bypass keyboard activation.** The real component performs the expected action after its initial focus settles. Programmatic command invocation or pointer clicks would remove the keyboard behavior that this regression protects.

**Wait a fixed interval after opening.** A timer approximates the focus producer and remains dependent on host load; the observed focus state is the relevant readiness signal.

## Consequences

The fixture adds bounded focus observation at keyboard interaction points while retaining its existing behavior assertions and dismissal deadlines. Ordinary repetition can pass without exercising the race, so controlled event ordering and the complete existing browser file remain necessary evidence alongside hosted CI.
