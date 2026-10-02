# Decision Record: Preserve task context through model continuations

Status: implemented

## Problem

Child model requests discard cached context after the first request. A pending compaction before the first model request skips initial collection entirely, and an Inbox task processed within the same loop reuses the preceding task's context. The numerical loop step includes pre-model jobs and multiple roots, so it cannot identify a task's first model preparation. These defects reproduce with synthetic SDK streams and unmodified Harness source; [issue #1520](https://github.com/SII-Holos/synergy/issues/1520) records the child and initial-compaction failures.

## Decision

The session loop tracks the root whose context it has prepared. It collects contributions at that root's first model preparation, replacing any prior task's cache, and reuses the result for subsequent root and child model requests. A successful initial preparation records collection even when no contribution is present. Commitment occurs once for the task. Pre-model compaction does not consume context initialization; a newly materialized Inbox root receives fresh context.

The existing contribution deadline, cancellation, fallback, injection metadata and loop-exit eviction remain in place. The Harness continues owning caching while registered domains own context content and retrieval. No host registration or public export changes are required.

## Alternatives considered

**Only allow children to reuse the cache.** This repairs child continuation but leaves initial compaction without a collected result and preserves stale context for another queued root.

**Collect at every model request.** This repeats retrieval and commitment, changes context during a task, and adds avoidable work to multi-step execution.

## Consequences

Context is stable across tools and real compaction but refreshed at task boundaries. Model-boundary regressions exercise child execution, compaction before the first request, and two Inbox roots within one invocation. The suite uses actual transactional storage and deterministic SDK streams; it is registered for the PostgreSQL matrix, whose real-database execution is separate from SQLite evidence.
