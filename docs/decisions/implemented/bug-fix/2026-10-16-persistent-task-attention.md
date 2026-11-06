# Decision Record: Preserve unresolved task attention across navigation

Status: implemented

## Problem

The progress entry treated idle execution as permission to remove every summary, including unresolved blocked and failed tasks. Opening an idle Session did not restore that entry. Selecting completed Todo items could also replace the DAG's attention with a completion label. Neither runtime inactivity nor a view preference establishes that a task has recovered. A separate readiness check required an explicit runtime status even though the runtime index omits idle Sessions, preventing resolved progress from dismissing against real snapshots.

## Decision

Canonical DAG state owns unresolved attention. A Session with blocked or failed nodes keeps the existing progress entry, even when execution is idle or its runtime status is temporarily unavailable. Initial hydration and navigation derive the same result without a new persisted flag, client cache or network path. Authoritative task resolution, retry status changes, cancellation and removal clear the corresponding attention; ordinary lifecycle rules then apply. Late attention cancels both stages of dismissal.

The header prioritizes unresolved DAG work independently of the selected tab. Mixed failure and blocker counts remain visible together. The progress ring uses that same header source; expanded counts and content retain the selected view's source. Tab selection remains under user control. Session changes close old details and discard old selection without hiding an admitted attention entry. The entry renders without an entrance fade; ordinary dismissal retains its short exit.

Temporary editor and workflow suppression keeps existing ownership and focus rules. Unresolved state restores the entry after suppression ends. Ordinary dismissal requires the connected, synchronized Session snapshot, then uses the shared activity resolver: a missing runtime entry with no persisted working state is idle. Loading and disconnection remain unknown, while persisted work still prevents dismissal. No new fetching, polling, event subscription, historical body read or transport field is required. This refines the receipt lifetime in [bottom activity controls](2026-10-04-session-bottom-activity-controls.md), whose layout, DAG retention and subagent interactions remain applicable.

## Alternatives considered

**Keep every completed progress entry visible.** It would retain resolved history beside the Composer instead of preserving only work that still needs attention.

**Remember a per-Session attention flag or dismissal setting.** It duplicates authoritative task state and risks retaining a warning after another client resolves the task.

**Only change the idle timer.** It leaves cold Sessions, navigation resets and Todo selection able to hide unresolved work.

## Consequences

Attention lasts as long as the accepted task state requires it; execution end is not a substitute for task resolution. Stale task statuses remain visible until their owner updates them, and ordinary replay and volatile snapshot recovery remain responsible for freshness. Browser tests exercise lifecycle races, cold and returning Sessions, mixed states, selected-view counts, focus, temporary suppression, stable frames and presentation request counts.

[Task-owned progress lifetime](2026-10-20-task-owned-progress-lifetime.md) extends admission to all unfinished tasks and supersedes the runtime-readiness requirement for ordinary dismissal. Canonical attention, selected-view counts and resource freshness remain authoritative.
