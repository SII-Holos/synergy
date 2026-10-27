# Compaction rejected unchanged attachment history

## Executive summary

A completed model summary failed the compaction commit check because cached attachment metadata differed from the same history loaded through the record-access upgrader. The omitted presentation purpose became `deliverable` only on read. Materializing current defaults before persistence and cache publication prevents this false conflict while retaining source-edit protection.

## Summary

The model completed its summary successfully, but the compaction attempt remained failed and out of context. Original history and earlier committed summaries remained available. The failure was in local source validation, not summary generation.

## Timeline

- Read-only inspection found a complete model call followed by a rejected summary commit, without an observed source-body write during generation.
- Comparing stored records with their access-upgraded representation isolated an added `presentation.purpose` on earlier user attachments.
- A synthetic two-task fixture with real storage and a warmed cache reproduced the exact commit error without concurrent edits. Standalone and nested attachments also failed warm/cold history parity checks.
- The write-path fix made those cases pass while existing source-edit, insertion and cursor-change tests continued to reject stale summaries.

## Root cause

The attachment schema permits an omitted purpose. `Session.preparePart()` captured attachment evidence and source context without materializing the default. The loop cache therefore retained the omitted value. Detached reads applied the existing attachment presentation migration and returned an explicit value. Compaction compared the complete part records and interpreted that representation difference as a source change.

The active task root is excluded from the covered-source comparison. An attachment could remain unnoticed while its own task compacted, then fail when a later task included that earlier root in the source interval. Existing compaction fixtures began with freshly read text history and missed incremental attachment writes.

## Guardrails

- [Model-history tests](../../packages/harness/test/session/model-history.test.ts) compare cached and detached histories, including nested attachments and cache eviction.
- [Compaction tests](../../packages/presets/test/session/invoke-compaction.test.ts) exercise a cached earlier-task attachment through summary commit and retain real-edit rejection.
- [Migration tests](../../packages/harness/test/session/attachment-migration.test.ts) retain explicit historical records and legacy classification.
- [Import tests](../../packages/harness/test/session/session-import.test.ts) preserve historical inspection purposes before applying current write defaults.
- [The decision record](../decisions/implemented/bug-fix/2026-10-27-attachment-default-consistency.md) keeps current defaults separate from historical inference.

## Lessons

Reader normalization must agree with newly published cache entries. Testing only cold reads can hide a mismatch that first becomes visible at a later consistency check. Fix the producer instead of weakening that check or discarding retained history.
