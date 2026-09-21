# Decision Record: Reload effective history after rewind and redo

Status: implemented

## Problem

A retained frontend window can contain messages from multiple earlier rollback branches. The latest rollback summary hides only its own dropped IDs; once a new branch invalidates prefix filtering, older dropped messages can reappear until a full page refresh. Explicit history sync previously refreshed only session metadata when redo was unavailable.

## Decision

The active session observes rollback identity and redo-validity changes and requests a history transition sync. That trigger forces the canonical latest message page, using existing replacement, freshness and part-eviction behavior. Immediate filtering also honors known dropped IDs when the cut root is outside the window. See [history transitions](../../../architecture/frontend-data-sync.md#history-transitions).

## Alternatives considered

**Expand the latest rollback summary into a frontend history ledger.** This duplicates the server-owned projection and adds a second source of rollback semantics.

**Refetch after every session update.** Streaming metadata updates would cause unrelated network and window churn; the history identity is the relevant boundary.

## Consequences

Rewind and redo converge without a browser refresh, including removal of obsolete part buckets. Each history transition reloads a bounded latest page; ordinary metadata updates do not. Behavioral tests cover transition planning, partial-window filtering, and the real SyncProvider replacing multiple branch windows and parts.
