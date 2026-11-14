# Decision Record: Page native Cortex metadata without child payloads

Status: implemented

## Problem

The live Cortex task list does not retain historical tasks after Runtime eviction. Cold task lookup could materialize every child Session, including private prompt and output fields, before selecting one task. Child metadata rows alone cannot answer a task-summary query because they deliberately omit Cortex identity and state.

## Decision

The Session domain owns a versioned Cortex summary projection beside its canonical child metadata. Native creation, mutation, removal, compatibility publication and explicit index rebuild update that projection in their existing writer transaction. Visible rows retain bounded descriptions, task/child/parent identities, status, timestamps and scalar metadata. Private prompt, output, error detail, tools, transfer state and continuation inputs are absent. Hidden tasks have no visible row.

Headers retain readiness and visible counts. Cursor pages seek by child identity with at most 64 returned rows, remain usable after their anchor is deleted, and reject another Scope or parent. Page reads do not materialize child Session records. A registered Session migration reconstructs old parent projections from native child metadata, reading one child record at a time and preserving canonical private fields. Explicit Cortex preparation runs that owning migration outside read snapshots. Ordinary Session metadata access does not trigger a task-catalog rebuild. Missing or future-version metadata cannot masquerade as an empty list.

The Cortex layer consumes this lower-level projection rather than introducing another durable Task owner or a reverse Session-to-Cortex import. `visibleSummaryPage()` validates the current Scope and may attach the existing live task's thin progress. Cold parent-qualified output lookup scans only summary pages before opening the selected canonical child. Exact child/task/parent/Scope/visibility checks remain authoritative. Imported duplicate task IDs remain ambiguous unless the child is explicitly qualified.

## Alternatives considered

**Retain all live Task objects indefinitely.** This duplicates historical private bodies in memory and still loses the catalog on restart.

**Slice an array of complete children.** The array has already admitted all private child metadata before pagination begins.

**Rebuild during every Session read.** Unrelated metadata and status observations would acquire a catalog scan and new writes. Preparation belongs to the explicit task-reading owner.

## Consequences

Native task-summary reads remain bounded independently of sibling count after preparation. The one-time owning upgrade can traverse a complete parent's metadata but never reads its message histories. Canonical task execution, output, cancellation and transfer owners remain unchanged. [Organization task metadata](2026-11-12-page-organization-task-metadata-at-native-checkpoints.md) consumes this native page through the private dispatcher and shared event checkpoints. The unqualified whole-Scope task search and task-panel rendering remain separate consumers.

## Verification

Real SQLite fixtures span 70 tasks over multiple pages while instrumenting child-record reads, exclude hidden/private fields, reject a foreign cursor and continue after deleting its anchor. Native writer rollback, visibility change, parent move, removal, registered upgrade, malformed future header and exact retained prompt/output are covered. A second Runtime opens the same Home and verifies paged summaries, full qualified output and duplicate-ID ambiguity. Existing Cortex cancellation, output and privacy suites retain their behavioral coverage.
