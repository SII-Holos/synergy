# Decision Record: Bound session history read work

Status: implemented

## Problem

Session repair and rollout settlement loaded historical message bodies to inspect header fields. Finite history requests hydrated the full transcript before selecting their window. These independent reads bypassed the loop-owned model cache and amplified work on long sessions.

## Decision

History owns raw, effective and model header queries. Canonical semantic derivation accepts Part metadata as well as complete Parts; legacy origin, visibility and root inference still uses the same function. Effective settlement retains roots before compaction. The continuation gate preserves its existing raw compaction view.

Repair shares one model header view and reads canonical unsettled tool candidates. Before settlement it rechecks the execution lease and the current assistant and tool records. Finite history selects the existing window and referenced roots before hydrating bodies. Unlimited history remains explicit and complete.

## Alternatives considered

**More hydration concurrency:** still performs work proportional to unrelated body size.

**A global message cache:** introduces cross-lease invalidation and retention without removing unnecessary reads.

**Display summaries as mutation authority:** cannot establish that a tool is still running under the same execution owner.

## Consequences

Header and candidate metadata work remains proportional to the required history. Legacy semantic derivation can inspect Part records but does not load streaming text chunks or externalize completed tool output. Selected large window bodies still cost their full size. Behavioral tests compare compaction and rollback views and reject body hydration in finite-window, repair and settlement paths. End-to-end latency and lazy execution-summary demand remain separate verification work.
