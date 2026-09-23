# Decision Record: Pause recovery preserves session recency

Status: implemented

## Problem

Recent-session navigation orders entries by activity. Recovery discovers unfinished historical work during Runtime startup and lazy project Scope startup, and records a pause without executing that work. A first pause used the ordinary session mutation path, which refreshed canonical activity and the navigation entry. The existing navigation freeze covered already-paused sessions but not their first recovery transition.

## Decision

`SessionLifecycle.pause` uses the activity-preserving option on `Session.update` for every pause reason. Recording execution state preserves canonical `time.updated` and navigation `lastActivityAt` together while retaining transactional index updates and publication of the changed pause state. `paused.since` remains the time the pause was recognized.

Explicit take-back actions and accepted input keep their existing activity updates. Recovery still leaves unfinished work paused, preserves its breakpoint and does not materialize queued input. The [session architecture](../../../architecture/session-and-messages.md#recovery) owns the lifecycle semantics.

## Alternatives considered

**Freeze only the navigation entry on the first pause.** Rebuilding the index from the refreshed canonical timestamp would promote the historical session again.

**Apply preservation only at the startup scan call site.** Workflow recovery and other pause writers share the same state mutation. The pause writer owns whether recording that state constitutes activity.

**Reconstruct old activity from message timestamps in a migration.** Message times cannot recover the exact overwritten activity because explicit metadata changes and queued input also affect recency. No historical timestamp rewrite is introduced.

## Consequences

Pause discovery cannot promote historical sessions, and navigation reconstruction preserves the result. Pause state still reaches clients without requiring a timestamp bump. Behavioral tests cover unfinished tool-call turns, queued input, first and repeated reconciliation, emitted navigation metadata, reconstruction, concurrent pause writers and explicit take-back recency.

The persisted schema is unchanged. This prevents future timestamp corruption; already-overwritten historical timestamps remain unchanged until a separately supported recovery with trustworthy prior activity evidence.
