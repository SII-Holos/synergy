# Decision Record: Keep interactive task introductions independent of drafts

Status: implemented

## Problem

Task introductions need variation without changing while a person writes. Random selection during rendering makes navigation, reconnect and presentation updates alter the introduction. Coupling demonstration state to message persistence would make a local interaction affect real work.

## Decision

The welcome selection module assigns a stable scene ID and seed per connection within a browser tab. Explicit new-task actions select uniformly from the remaining registered scenes. A single registered scene remains usable. Session storage restores the assignment after reload; unavailable storage leaves the in-memory assignment intact. Removed or invalid stored entries are replaced with a valid selection. Scene IDs are supplied by the caller, allowing additions without changing the selection algorithm.

Selection records contain no message or attachment data and do not create server sessions. New-task presentation and message draft ownership remain separate.

The Web-owned registry lazy-loads one scene into a shared presentation with pause, loading and retry controls. Explicit new-task navigation updates its assignment even on the same URL; project selection does not. Existing Session routes retain their ordinary empty/loading presentation. The island module uses an independently tested road graph and SVG illustration. The car advances only through reciprocally connected road exits; water requires bridge pieces. Pointer placement, keyboard grid navigation, rotation, night lighting and reset operate on local state. The introduction action reuses revision-checked task starters.

The presentation pauses during input, obscuring dialogs, expanded editing, offscreen visibility and background tabs. It distinguishes actual input from initial editor autofocus. Reduced motion starts paused and removes decorative loops while retaining explicit simulation actions. Local scene memory survives presentation remounts within the current assignment; only ID and seed survive reload. The shared container and its scene modules do not change Plugin interfaces.

This replaces the three starter cards described in [workbench optimization](2026-09-29-frontend-workbench-optimization.md); its column geometry, draft safeguards and project/file entry rules remain authoritative. Continuous motion has an explicit pause control following [WCAG 2.2.2](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html).

The landscape module runs a bounded cellular simulation in a dedicated Worker and renders its latest acknowledged frame in Canvas 2D. Water movement conserves cell count, terrain blocks movement, watered seeds grow to a finite height, and low gravity changes stepping frequency. Commands and replies carry a preview generation; frame acknowledgement bounds queued rendering work. Pause stops the Worker timer; unmount terminates it. Canvas colors consume resolved theme tokens and redraw on same-mode theme changes. Worker ownership and messaging follow the [Web Workers API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers).

The illustrated bookshop is an authored eight-node story with three reachable endings. Its node-owned choices update local scene state and bounded reading history; invalid actions cannot jump between nodes. Object hotspots and equivalent text buttons share the same actions. Backtracking and restart preserve keyboard focus, and the editable task starter includes the current story direction without automatically submitting it.

## Alternatives considered

**Independent random selection on every render.** It interrupts interaction and can immediately repeat the same introduction.

**A scene picker or automatic rotation.** It adds navigation unrelated to starting a task and can replace the user's current activity.

**Server-persisted demonstration state.** Local onboarding does not require a backend model, cross-device synchronization or model execution.

## Consequences

Selection remains stable across repeated reads and reloads. Different connections and browser tabs have independent histories. Behavioral tests cover exclusion, extension to additional scenes, reload, invalid records and storage failure.
