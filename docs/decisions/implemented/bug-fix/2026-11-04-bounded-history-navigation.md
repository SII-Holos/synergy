# Decision Record: Bounded history retains navigation progress

Status: implemented

## Problem

Keeping the newest message suffix during every older-page request can advance the cursor while discarding the entire requested page. A bounded window then prevents reading older history. Execution windows can similarly lose their backward navigation after eviction, and a background latest snapshot can suppress subsequent events if it advances freshness without replacing the retained history.

## Decision

Explicit older-message paging retains the older requested span and records a missing latest tail when newer rows leave. Latest replacement retains the newest span. Pending arrivals remain strictly newer than the retained window. The TLA model checks older-page progress separately from latest replacement; this supersedes [history cap keeps the newer tail](../../archived/bug-fix/2026-11-02-history-cap-keeps-newer-tail.md).

Execution windows preserve navigation markers for either evicted side, and expanded branches support anchored backward paging. The shared branch budget can empty an inactive branch instead of exceeding the budget by retaining one row per branch. An empty branch remains reloadable. Optimistic message roots enter their ordered window through binary insertion.

A latest snapshot that preserves an existing history window validates its request generation and sequence without committing a message-resource watermark. Its independently versioned latest-context projection may still advance. Only an applied message snapshot consumes the corresponding event range.

## Alternatives considered

**Preserve the newest suffix for every operation.** Rejected because a bounded older-page request can make no visible progress even while its cursor advances. A model invariant must prove the user operation, not merely the chosen eviction order.

**Raise or remove window limits.** Rejected because longer transcripts and many expanded branches still require bounded residency and recoverable navigation.

**Commit freshness for a discarded latest page.** Rejected because an event older than that response can still contain an unapplied change to retained history.

## Consequences

Reading older messages can evict newer rows; return-to-latest reloads them. Execution navigation uses retained row identities as anchors after eviction. Regression coverage includes traversing 1,200 messages with a 500-message cap, delayed latest snapshots, reduced execution capacity and browser-driven branch paging. The [frontend sync reference](../../../architecture/frontend-data-sync.md) owns the current semantics.
