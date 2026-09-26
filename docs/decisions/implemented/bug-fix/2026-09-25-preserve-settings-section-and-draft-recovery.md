# Decision Record: Preserve settings section and draft recovery

Status: implemented

## Problem

Settings waited for unrelated model and agent requests before exposing navigation. Request failures could look like empty data or a permanent loader. Search metadata omitted font fields and stopped at section navigation. Escape bypassed the common close path by doing nothing, and server error responses could be treated as successful saves.

## Decision

Load resource groups only when a consuming section opens. Keep their last successful values and expose local failure and retry state. Navigation remains available independently. Use catalog field labels for search results and locate rendered rows with focus, scrolling and a visible highlight. Reuse the font descriptors already used by the form.

Route Escape, Close and Cancel through the same draft guard. The discard confirmation closes before its parent. Save requests propagate server errors, reject duplicates while pending and retain drafts on failure. Explicit saves stay on the settings page. Preserve field ownership from the generated domain summaries.

## Alternatives considered

A single all-or-nothing resource gate couples unrelated settings to every service. Treating failures as empty arrays hides recovery. Closing settings after save would lose the user’s location and prevent inspection of the result. Replacing forms with editable search results would create a second draft surface.

## Consequences

The shared Dialog accepts an optional Escape callback while keeping its default dismissal behavior. Settings resources retain cached data after refresh errors; only the affected section offers retry. Browser tests cover clean and dirty dismissal, nested Escape, actual HTTP error responses, duplicate submission and late-rendered field focus. Resource tests cover independent retries and retained snapshots. The product contract and frontend Skill record these requirements.
