# Decision Record: Preserve resumable rollout segments on user pause

Status: implemented

## Problem

A user pause preserved the unfinished assistant message but finalized its execution segment as cancelled. Deferred rollout reconciliation could then cancel the root after Continue had reopened it, causing the next model call to fail admission.

## Decision

Both invoke-loop segment finishers read the existing `PausedTurnAbort` signal. A resumable stop records an interrupted segment and supplies no terminal root outcome. Normal reconciliation keeps the unanswered root open; an explicit Continue appends to the same root and normal completion closes it. Abandonment and internal cancellation retain their terminal outcomes. This extends the [session pause authority](../architecture/2026-09-20-session-paused-state-authority.md) through execution evidence without introducing another pause field.

## Alternatives considered

**Consult the current pause latch during deferred reconciliation.** Continue clears that latch before the earlier reconciliation necessarily runs, so the outcome would depend on scheduling.

**Reopen every cancelled run at segment admission.** That would erase intentional cancellation semantics and allow automatic execution to override a user's stop.

## Consequences

The live provider regression checks the interrupted segment, open root, resumed model call and completed root. Abandonment, unattended stops, internal cancellation, continuation, recovery and explicit rollout cancellation retain separate tests. No persisted schema or transport change is needed.
