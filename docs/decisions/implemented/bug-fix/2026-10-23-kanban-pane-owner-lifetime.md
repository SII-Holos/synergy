# Decision Record: Preserve Kanban pane owners through disposal

Status: implemented

## Problem

New recent Sessions can replace visible Kanban panes. Grid and focus layouts passed a conditional `Show` accessor into each pane; after its key disappeared from the snapshot, descendant cleanup could read that invalid accessor and fail the entire board. Keyed rows must retain the identity needed for disposal without losing drafts during ordinary updates.

## Decision

Both layouts use one pane accessor that reads current snapshots while retaining the last value for its mounted key. The keyed row owns disposal; removing the key does not invalidate its owner's cleanup reads. The focus main pane also keys its lifetime by Session, while retained keys continue receiving updated values without remounting.

## Alternatives considered

**Remount every pane on snapshot updates.** This avoids stale accessors but discards input focus, drafts and transcript state during ordinary status updates.

**Catch the rendering exception.** A fallback cannot complete the skipped cleanup or preserve the board's remaining panes.

## Consequences

The retained value lasts only until its row is disposed; no additional persistent state or global cache is introduced. Regression tests cover grid and focus removal, clearing all panes, and retaining an existing input and draft when a new Session replaces another pane. Real-instance acceptance includes new Session arrivals while a populated board is mounted.
