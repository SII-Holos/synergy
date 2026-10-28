# Decision Record: Publish consistent live turn totals

Status: implemented

## Problem

A continuing task can involve several Workspace generations. Publishing a subset while their historical comparisons are still loading replaces accepted totals with a temporary zero. Treating a failed historical comparison as an empty result also confuses unknown coverage with verified absence of changes.

## Decision

The Session observer admits live publication only after all prior Workspace initialization completes. Dirty notifications accumulate during initialization and participate in the first complete refresh. This strengthens the publication lifecycle in [incremental turn changes](../feature/2026-10-23-live-turn-file-changes.md) without changing snapshot storage or its omission rules.

Historical statistics distinguish a successful empty comparison from an unresolved failure. A successful live comparison of the same Workspace generation takes precedence. Otherwise, an unresolved range prevents publication of a replacement aggregate: an atomic state-only summary update marks incomplete coverage while preserving accepted file evidence, totals, revision and observation time. Missing totals remain absent. Subsequent invalidations retry failed historical reads; failure does not create an automatic refresh loop. Recovery publishes a complete comparison even when its endpoints have not changed.

Each cached Workspace revision holds an independent read lease, including before aggregate publication. Replacement statistics acquire the candidate lease before replacing the cache; a failed read releases that candidate only. Successful replacement and observation cleanup release the preceding cache ownership. Deferring publication therefore cannot let an unrelated failed refresh invalidate a retained fallback.

The existing omission policy remains intact: excluded files do not enter a new comparison or acquire restoration authority. A complete comparison can still establish a genuine zero. No wire format or persistence migration is needed.

## Alternatives considered

**Keep the maximum observed count.** Net changes can legitimately disappear after restoring the original bytes, so a monotonic counter reports incorrect results.

**Publish partial totals with an incomplete label.** Replacing accepted evidence with a narrower set still creates the reported jump and conflates unavailable comparisons with no changes.

**Fail task admission on historical comparison errors.** File-statistics availability must not prevent otherwise executable work; retaining explicit incomplete evidence preserves both execution and diagnostic information.

## Consequences

The first live publication waits for initialization rather than the first ready Workspace. Failed history can leave older recorded totals visible until another invalidation succeeds. Existing comparison leases and atomic summary merges keep numbers aligned with their recorded evidence. Regression coverage observes intermediate message events during blocked multi-Workspace initialization, preserves intervening dirty notifications, distinguishes absent and accepted statistics, verifies bounded retries, and retains genuine live cancellation to zero.
