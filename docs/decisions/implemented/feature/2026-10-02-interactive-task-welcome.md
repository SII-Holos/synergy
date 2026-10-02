# Decision Record: Keep interactive task introductions independent of drafts

Status: implemented

## Problem

Task introductions need variation without changing while a person writes. Random selection during rendering makes navigation, reconnect and presentation updates alter the introduction. Coupling demonstration state to message persistence would make a local interaction affect real work.

## Decision

The welcome selection module assigns a stable scene ID and seed per connection within a browser tab. Explicit new-task actions select uniformly from the remaining registered scenes. A single registered scene remains usable. Session storage restores the assignment after reload; unavailable storage leaves the in-memory assignment intact. Removed or invalid stored entries are replaced with a valid selection. Scene IDs are supplied by the caller, allowing additions without changing the selection algorithm.

Selection records contain no message or attachment data and do not create server sessions. New-task presentation and message draft ownership remain separate.

## Alternatives considered

**Independent random selection on every render.** It interrupts interaction and can immediately repeat the same introduction.

**A scene picker or automatic rotation.** It adds navigation unrelated to starting a task and can replace the user's current activity.

**Server-persisted demonstration state.** Local onboarding does not require a backend model, cross-device synchronization or model execution.

## Consequences

Selection remains stable across repeated reads and reloads. Different connections and browser tabs have independent histories. Behavioral tests cover exclusion, extension to additional scenes, reload, invalid records and storage failure.
