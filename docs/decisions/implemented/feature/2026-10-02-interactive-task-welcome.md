# Decision Record: Keep interactive task introductions independent of drafts

Status: implemented

## Problem

Task introductions need variation without changing while a person writes. Random selection during rendering makes navigation, reconnect and presentation updates alter the introduction. Coupling demonstration state to message persistence would make a local interaction affect real work.

## Decision

The welcome selection module assigns a stable scene ID and seed per connection within a browser tab. Explicit new-task actions select uniformly from the remaining registered scenes. A single registered scene remains usable. Session storage restores the assignment after reload; unavailable storage leaves the in-memory assignment intact. Removed or invalid stored entries are replaced with a valid selection. Scene IDs are supplied by the caller, allowing additions without changing the selection algorithm.

Selection records contain no message or attachment data and do not create server sessions. New-task presentation and message draft ownership remain separate.

The Web-owned registry lazy-loads one scene into a shared presentation with a single game status control, loading and retry states. Explicit new-task navigation updates its assignment even on the same URL; project selection does not. Existing Session routes retain their ordinary empty/loading presentation. Current game content and interaction choices are specified in [playable welcome games](2026-10-02-playable-welcome-games.md).

The presentation pauses during input, obscuring dialogs, expanded editing, offscreen visibility and background tabs. It distinguishes actual input and manual outside clicks from initial editor autofocus. Reduced motion starts paused and removes decorative loops while retaining explicit simulation actions. Local scene memory survives presentation remounts within the current assignment; only ID and seed survive reload. The shared container and its scene modules do not change Plugin interfaces.

This replaces the three starter cards described in [workbench optimization](2026-09-29-frontend-workbench-optimization.md); conversation/composer column geometry and project/file entry rules remain authoritative. The current welcome itself spans the chat pane and never modifies the draft. Continuous motion is pauseable through the focusable game status control and Escape following [WCAG 2.2.2](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html).

Environmental animation pauses at its current position rather than restarting. Visibility follows the marked artwork rather than its surrounding actions, so scrolling past the scene in a short window pauses simulation even while task controls remain visible. Shared browser fixtures cover all scenes, narrow and doubled-scale layouts, same-mode theme changes, explicit new-task navigation, stale loads and retry without draft loss.

## Alternatives considered

**Independent random selection on every render.** It interrupts interaction and can immediately repeat the same introduction.

**A scene picker or automatic rotation.** It adds navigation unrelated to starting a task and can replace the user's current activity.

**Server-persisted demonstration state.** Local onboarding does not require a backend model, cross-device synchronization or model execution.

## Consequences

Selection remains stable across repeated reads and reloads. Different connections and browser tabs have independent histories. Behavioral tests cover exclusion, extension to additional scenes, reload, invalid records and storage failure.
