# Decision Record: Keep historical work off interactive navigation

Status: implemented

## Problem

Session navigation, the first queued message and Library opening became slow in homes with thousands of historical sessions. Page disposal discarded useful Scope state, usage snapshot reads refreshed all history, and recovery repeatedly walked empty inbox and rollout subtrees. Deadline handling also prevented late message convergence and hid actual navigation completion times.

## Decision

Recently viewed Scopes join the bounded inactive LRU. Library controls remain outside content suspension. Usage snapshot reads are cache-only and nullable; incremental refresh runs through the progress stream, concurrent callers share its work, and full recompute remains explicit. CLI stats retains incremental refresh semantics.

Session and part reads use existing typed SQL indexes. Inbox recovery discovers candidate records before loading Session metadata. A registered migration moves continuation intents to an indexed Session record kind, with atomic source removal; normal startup has one current discovery path. Message chronology, rollback and canonical derivation remain unchanged. Automatic adjacent-session prefetch no longer competes with the requested page.

Startup recovery reads committed journal evidence in bounded batches at a fixed revision. Every event still passes schema and sequence validation, and missing committed evidence still fails recovery. This removes a separate read transaction per historical event without weakening the recovery boundary.

Workflow status recovery uses the same indexed Session discovery contract. Scope bootstrap exposes per-field `Server-Timing` durations so remaining cold-start dependencies can be distinguished from message loading and rendering.

Handoffs still converge after a timeout. Navigation timing retains at most 32 attempts and records eventual completion. Performance read models aggregate window counts and percentiles in SQLite instead of discarding older rows at a fixed sample cap. Historical knowledge retries use independently recorded operations with source attribution; matching live-root encoding retains causal ownership.

## Alternatives considered

**Increase loading deadlines.** This leaves historical work on the interaction path and prolongs stale state.

**Retain every Scope.** This removes reloads but revives unbounded frontend retention. The existing inactive limit remains enforced.

**Skip recovery or reuse terminal rollouts.** This can lose pending work or corrupt execution accounting. Indexed discovery and explicit operation ownership preserve those contracts.

**Raise metric row caps.** Larger raw windows still truncate eventually and allocate more Control Plane memory. Database aggregation keeps results exact while bounding transferred detail.

## Consequences

Opening panels reads existing state promptly. Statistics can be stale until sync; their computation timestamp remains available. The continuation migration performs one historical scan during upgrade. Active Scope state and message windows retain their existing memory budgets. SQL aggregation still costs work proportional to the selected metric window, but returns bounded buckets and ranked detail instead of raw history.
