# Decision Record: Bound session interaction work to its selected owners

Status: implemented

## Problem

Session execution summaries scanned every installation usage counter inside one storage snapshot, so a new empty Session could occupy the shared reader for over a minute and block unrelated navigation. Native snapshot capture serialized thousands of file reads and temporary object writes. A failed first input whose receipt remained absent left the Web handoff in an indefinite loading state. Navigation timing omitted the pre-route wait and ended before the composer was ready. The measurements and reproduction are in the [investigation](../../../research/2026-10-03-session-latency-audit.md).

## Decision

Execution summaries pass the selected Scope into Usage. Usage discovers descendant ownership through compact lineage, reads session owners through existing indexed queries and operation owners through their exact prefixes, and merges ordered streams using the storage cursor order. A complete selected-owner collection keeps one lineage traversal instead of rediscovering it for each page. Execution snapshot, message and usage phases have separate spans. Global reporting retains its global scan. Accounting, descendant inclusion and pagination remain complete; unrelated counters cannot enter selected-owner reads.

Native snapshot capture admits at most sixteen file reads per batch, retains exact bytes after the existing identity checks, deduplicates immutable blobs before concurrent temporary writes, and batches Git object ingestion. All admitted reads and writes drain before cleanup, including failures. Read and object-ingestion timing are recorded separately. No filesystem timestamp cache substitutes for captured bytes.

The first-input handoff distinguishes accepted, unavailable and definitively missing receipts. Unavailable reads remain observable; a missing receipt stops polling, removes only the pending optimistic message and exposes recovery. The captured draft remains available. Explicit retry reuses the same message identity and payload, owns a fresh inbox request watermark, and excludes concurrent retries. A receipt recovered after a transport failure clears only the unchanged submitting draft. Canonical visibility can confirm acceptance when both receipt responses and progress events were lost. Durable and canonical confirmation share one callback, guarded by message identity. Worktree availability errors retain their existing handling.

Navigation measurement begins at the user's navigation action, retains its identity through Scope lookup and parameter hydration, and completes after data and composer readiness reach a paint. A newer foreground navigation supersedes the preceding sample.

Automatic Library context has a three-second contribution deadline, with cancellation owned by Harness and the existing always-memory fallback. Memory and Experience share one query embedding; its failure skips semantic retrieval instead of starting duplicate embedding requests. Explicit Library searches and stored vector identities are unchanged. This bounds optional preparation while allowing slower knowledge retrieval through explicit tools.

## Alternatives considered

**Increase storage timeouts.** This hides reader contention without reducing unrelated work and lengthens failure recovery.

**Cache complete execution summaries globally.** This adds invalidation across lineage, imports, clears and live accounting. Existing owner indexes remove the broad counter scan without a second authority.

**Skip snapshots or trust unchanged timestamps.** Both can lose same-size edits or external file changes. Bounded concurrency preserves the byte and identity checks.

**Let optional recall consume the general fifteen-second context budget.** Live traces showed failed remote embeddings and duplicate retries delaying a trivial first response. A Library-owned interactive deadline limits that dependency without changing other context contributors.

**Automatically resend uncertain inputs.** An unavailable receipt does not prove absence and can duplicate execution. Recovery remains explicit and preserves message identity.

## Consequences

Compact lineage discovery still scales with the selected Scope, and opening a large owner's execution history still reads that owner's evidence. Capture uses more concurrent I/O while retaining a fixed upper bound. First-history preparation and external model latency remain separately measurable. Behavioral tests cover unrelated damaged counters, descendant operation pagination, actual captured Git objects, receipt terminal polling and pre-route timing; the report separates those fixtures from production measurements.
