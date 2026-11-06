# Decision Record: Recover usage from retained response evidence

Status: implemented

## Problem

A streamed response without an accurate media type could retain its raw usage while the numeric ledger and transport content timing stayed unknown. Advancing the live capture checkpoint made ordinary rebuilds skip these records, and an existing incomplete estimate prevented recovered tokens from restoring cost coverage. See the [postmortem](../../../postmortem/0061-streamed-usage-recovery.md).

## Decision

The shared response parser uses bounded leading-content detection for SSE and JSON. Transport timing adopts the detected framing without resetting request or header observations. Both live capture and historical replay use this parser, preserving original bytes and uncertainty for unusable data.

An after-convergence usage migration schedules background repair through the existing maintenance service. A private durable replay cursor is independent of live capture progress and fixes each owner's upper journal revision. Manual rebuild uses the same path. Repairs update derived facts, indexes, revision and notifications in a transaction; terminal execution records remain immutable. Same-source replay preserves recovered evidence and unchanged records do not advance the revision.

Incomplete estimates are recalculated using the saved attempt price evidence or, when absent, the original call snapshot. Explicit missing prices remain unknown, and subscription equivalents remain distinct from API spending. Historical timing is never inferred from archive parsing.

## Alternatives considered

**Trust response headers exclusively.** Retained real responses and byte-fragmented regressions demonstrate valid SSE without that metadata. Restricting the correction to one provider would leave the shared parser and other mislabeled responses inconsistent.

**Require manual rebuild or reset live capture checkpoints.** Manual-only recovery leaves existing users with incorrect history. Reusing the live cursor conflates fresh capture with repair and risks interfering with concurrent requests. Background repair uses a separate bounded cursor.

**Rewrite terminal execution evidence or use current catalog prices.** Either would change historical evidence. Derived corrections retain the original execution and use only its saved prices, leaving unavailable amounts and timing unknown.

## Consequences

Repair adds bounded background reads and minimal internal cursor state, while preserving startup admission and existing HTTP and frontend schemas. Explicit deletion markers remain authoritative. Missing artifacts can prevent recovery, and historical generation speed cannot be recovered without original transport observations. Existing task panels receive updated values through the normal usage event; their content and presentation are unchanged.
