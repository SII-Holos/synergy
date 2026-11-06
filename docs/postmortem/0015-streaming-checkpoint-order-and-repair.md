# Streaming checkpoint ordering and repair

## Executive summary

Streaming replies could lose text in a hidden page or remain incomplete after an out-of-window checkpoint. Queue tests covered delta merging and checkpoint replacement separately, but missed a checkpoint followed by a delta in one flush. Recovery tests also missed history navigation and concurrent compaction. The fix preserves event order and validates repair against the real GlobalSync provider.

## Summary

The PR report described a reasoning segment shrinking from 5437 to 4665 characters and a dropped checkpoint with a loaded 56-message window. These are reported observations; the review reproduced the ordering defect with a deterministic smaller case. Starting with `a`, queue a checkpoint containing `ab` followed by delta `c`: the old queue emitted the delta first and left `ab`, losing `c`. A newly created part could lose the delta entirely.

## Timeline

- 2026-09-18: PR #1410 proposed prefix preservation, scheduled repair, and prefetch part-snapshot gating.
- Review reproduced hidden-page data loss, history displacement, and authoritative prefix truncation with failing tests. Review also identified premature prefetch watermark acceptance and repair requests superseding compaction.
- Queue ordering, latest-window guards, request ownership, and prefetch acceptance order were corrected before merge.

## Root cause

The queue flushed its separate hidden-delta map before queued state events regardless of arrival order. Clearing deltas that preceded a checkpoint did not protect deltas that followed it. Prefix preservation alone could not recover the missing prefix. Separately, sharing a forced reload between repair and compaction discarded the stronger request's invalidation intent, and treating a loaded history window as latest displaced the user's position. Existing helper tests did not exercise those request interleavings in the actual provider.

## Guardrails added

- [Event queue tests](../../apps/web/test/context/event-queue.test.ts) cover existing and new parts, checkpoint-before-delta ordering, and checkpoint replacement across visibility changes.
- [GlobalSync integration test](../../apps/web/test/context/global-sync-part-repair.dom.test.ts) covers history at enqueue, dispatch, and response time, diff preservation, both compaction/repair orderings, authoritative truncation, and scope release.
- [Checkpoint tests](../../apps/web/test/context/part-checkpoint-merge.test.ts) distinguish delta-bearing prefixes from authoritative writes.
- The [decision](../decisions/implemented/bug-fix/2026-09-18-streaming-part-checkpoint-convergence.md) and [frontend workflow](../../.synergy/skill/develop-frontend/SKILL.md) document ordering and validation requirements.

## Lessons

Convergence must be tested with complete event sequences and request races. A local heuristic that prevents shrinking does not establish that the resulting text contains every increment. Background repair must preserve the user's window and any stronger in-flight operation.
