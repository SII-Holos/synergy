# Decision Record: Bounded coding tool observations

Status: implemented

## Problem

File tools applied inconsistent output budgets. Explicit small reads were widened to 120 lines, disjoint ranges could exceed the byte budget, and successful anchored edits replayed entire files. Search tools minted usable tags while their instructions required another read. Specialist descriptions appeared in both the primary prompt and task tool catalog.

## Decision

Read and search tools share UTF-8 output accounting across ranges and files. Explicit read limits are honored; the default remains 2,000 lines. Omitted source has a recovery location and never becomes displayed-line evidence. Search context can supply enough evidence for direct anchored editing.

Search recovery distinguishes a requested result-count limit from the shared byte budget so callers can adjust the binding constraint. AST metadata retains every distinct match range while listing each source line once; overlapping matches do not duplicate displayed rows or editing evidence.

Read evidence retains the content version captured with the snapshot, including AST searches. A later edit compares that version with current bytes; a budget-limited observation does not authorize unseen rows, and a changed file requires fresh evidence. The public tool registrations and test fixtures retain the Workspace ownership and explicit Runtime boundaries.

Anchored edits return final tags and compact previews while preserving the existing UI diff. Previously known unchanged rows and submitted rows that survive formatting remain known across versions. A partial write reports committed sections and the remaining error instead of silently appearing complete. Truncation recovery permits targeted inspection without requiring delegation. Specialist selection principles remain in the primary prompt; the full permission-filtered catalog belongs to the task description under the [single-owner guidance decision](../simplification/2026-09-24-single-owner-tool-guidance.md).

The entire edit reply, including diagnostics, warnings, reload results and the recovery footer, fits 50 KiB and 2,000 lines. Commit summaries and tag invalidation precede previews; complete feedback exceeding the budget is retained through the existing tool-output file mechanism. Displayed-line evidence is recorded only after selecting complete preview rows. The same accounting covers no-op feedback, whose diagnostics can also exceed the budget.

Provenance: [Pi bounded reading](https://github.com/earendil-works/pi/blob/890f920884f6d21fc7617d236ef9e1cc5d7a0ef8/packages/coding-agent/src/core/tools/read.ts), [OMP edit previews](https://github.com/can1357/oh-my-pi/blob/d716bcf60ab0a2e7ece1fdf382c0d143fef1f307/crates/pi-edit/src/session.rs#L364).

Local adaptation: retain Synergy's zero-based offsets, hashline language, formatter lifecycle, permissions and UI metadata. Reuse the previously ported compact-preview algorithm with final-file numbered diffs.

## Alternatives considered

**Smaller fixed default windows.** A smaller window can cause repeated reads and more model calls. The default is unchanged; explicit requests and aggregate budgets are enforced instead.

**Success-only edit acknowledgements.** These omit useful final-file evidence after formatting. Compact previews retain nearby context without replaying unrelated code.

**History rewriting or learned compression.** Both require separate long-task and provider-protocol validation. This change shapes new observations before they enter history.

**Couple specialist catalog deduplication to the initial observation change.** The combined pilot regressed on the delegation task in both repetitions without establishing causality, so its selected tool candidate retained the original catalog. That experimental disposition is preserved in the [pilot report](../../../research/context-efficiency/2026-09-21-coding-observations-pilot.md). The [separate single-owner guidance decision](../simplification/2026-09-24-single-owner-tool-guidance.md) owns the implemented catalog deduplication and its later evidence; this observation decision does not require duplicate catalogs.

## Consequences

Output volume is bounded independently of match count. Large selections may require targeted continuation, and a single oversized line cannot supply a partial editable anchor. Tests cover UTF-8 boundaries, exact limits, search-to-edit and consecutive edits. Byte reductions alone do not establish token, billing, latency or task-quality improvements; model-backed comparisons must count all calls and recovery reads.

The fixed-input observation probe exercises the same tool sequence across source versions and emits versioned byte measurements. Document extraction windows, empty seen sets, formatter invalidation, multi-hunk row numbering and partial commit failures have focused regression coverage. Snapshot-cap previews expose complete prefix rows and explicitly require a non-anchored recovery path.
