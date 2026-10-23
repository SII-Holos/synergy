# Decision Record: Bound session history read work

Status: implemented

## Problem

Session repair and rollout settlement loaded historical message bodies to inspect header fields. Finite history requests hydrated the full transcript before selecting their window. These independent reads bypassed the loop-owned model cache and amplified work on long sessions.

## Decision

History owns raw, effective and model header queries. Canonical semantic derivation accepts Part metadata as well as complete Parts; legacy origin, visibility and root inference still uses the same function. Effective settlement retains roots before compaction. The continuation gate preserves its existing raw compaction view.

Repair shares one model header view and reads canonical unsettled tool candidates. Before settlement or terminalizing an assistant it rechecks the execution lease and the current canonical records. Finite history selects the existing window and referenced roots before hydrating bodies. Unlimited history remains explicit and complete. Rollout admission records its actual input and segment without computing an unused complete-history fingerprint; existing optional fingerprints remain readable in historical evidence.

Last-exchange refresh captures the model headers, membership generations and source revisions under short snapshots. The PartContent owner reads immutable chunks outside SQL transactions and computes the exact joined, trimmed UTF-16 prefix. A short writer validates all selection sources and merges only the preview into current Session info. Changed sources retry, including after a removed chunk; unchanged-source failures propagate. Runtime-local single flight coalesces concurrent refreshes, and inherited transactions are rejected.

Internal execution phases record preparation separately from actual worker queueing. Enqueue and start callbacks own the queue/running transitions. Preparation spans distinguish repair, headers, tool candidates, file baseline and model input; public execution status and historical samples remain unchanged.

HistoryDisplay stores versioned, Part-local execution facts separately from public Part summaries. Each message has an independent readiness cursor tied to its Part membership generation. Execution readers batch canonical Part headers under the same snapshot as message headers. Inline content and proven checkpoint prefixes need no derived writes. Only unresolved exact normalized previews prepare bounded batches outside transactions, with canonical revision checks before publication. Canonical message headers supply completion, errors, root identity and accounting at read time, so message-only changes cannot leave those derived values stale. Ordinary display backfill preserves only facts whose source revision still matches. The session migration registers the version without eagerly reading history.

One runtime ExecutionService entry separates root Context metadata, complete summary metadata and lazy detail indexes. Root reads share a revision cut and ordered Context index; only changed calls repeat attribution calculations. Delayed usage notifications cannot replace newer revisions, and message invalidations reread canonical headers. Summary statistics retain their existing complete shapes and accounting owners while consuming compact facts. Context source reads validate owner, run and call directly. Explicit summary and trajectory readers share preparation, but root readers cannot keep abandoned summary work alive.

The existing view transport negotiates demand and typed projection states. Root and preparing states never masquerade as a complete Summary. Lease-owned immutable checkpoints preserve the Context window and complete ready Summary; ordinary HTTP and legacy projection contracts remain unchanged. The Web dashboard retains summary demand for its existing statistics, while standalone Context readers retain only root metadata. Session references always fetch the existing finite preview window instead of treating a partial local cache as complete.

## Alternatives considered

**More hydration concurrency:** still performs work proportional to unrelated body size.

**A global message cache:** introduces cross-lease invalidation and retention without removing unnecessary reads.

**Display summaries as mutation authority:** cannot establish that a tool is still running under the same execution owner.

## Consequences

Header and candidate metadata work remains proportional to the required history. Legacy semantic derivation can inspect Part records but does not load streaming text chunks or externalize completed tool output. Selected large window bodies still cost their full size. Behavioral tests compare compaction and rollback views and reject body hydration in finite-window, repair and settlement paths. End-to-end latency and lazy execution-summary demand remain separate verification work.

Preview reads do not validate unconsumed tails. Long leading or trailing whitespace can require additional chunks to establish the exact result; there is no artificial byte cap. Barrier tests hold artifact reads while independent writes, replacement, membership changes and deletion complete, and verify that stale previews are neither published nor used to resurrect deleted Sessions.

Execution facts add bounded derived writes only when canonical headers cannot establish the exact preview. Cancellation preserves committed cursors; unchanged-source failures remain errors instead of silently hydrating entire transcripts. Streaming writes reuse inline or proven checkpoint prefixes and defer unresolved normalized prefixes to explicit readers. Public Part-page schemas strip these internal facts. Detail surfaces show preparation stages and actual processed units; per-message Part progress is explicitly local to that message. Refreshes and failures retain the previous complete summary with a visible status and retry action.
