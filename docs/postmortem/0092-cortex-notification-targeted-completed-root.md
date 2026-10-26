# Cortex notification targeted a completed root

## Executive summary

A successful background task paused its parent when the completion notification tried to continue a newer, completed root. Notification routing selected the correct root, but execution admission treated that root's earlier completion as permanently closed. Message scheduling and Rollout continuation needed one admission rule.

## Summary

Root A launched background work. A later input created root B, which finished before that child returned. The child kept A's Rollout open through its original lineage; B's Rollout completed normally. Cortex delivered a steer to B, and the Session loop persisted it before attempting another execution segment. The ledger rejected that segment with `Cannot append execution to a terminal rollout`, causing a failed pause before model dispatch.

## Timeline

- 2026-10-26: runtime logs and retained message and Rollout metadata established the distinct launch and notification roots.
- 2026-10-26: a deterministic provider with real Cortex, Inbox, Session invocation and storage reproduced the same error after the newer root finished.
- 2026-10-26: dedicated continuation admission allowed the notification to produce a new segment and reply on the latest root. A separate regression covered explicit Continue after notification materialization.

## Root cause

The shared admission lock prevented simultaneous reconciliation from closing an active continuation, but it could not reopen a run already completed before notification arrival. Existing continuation tests kept the target run open or checked settlement of an older root; they did not exercise a child returning after a newer root had completed.

## Guardrails

[The Cortex regression](../../packages/harness/test/cortex/completion-continuation.test.ts) checks final result retrieval, latest-root attribution, retained earlier segments and duplicate suppression through the real loop. [Ledger recovery tests](../../packages/harness/test/session/rollout-resume.test.ts) preserve cancellation and recording failures. [Continue tests](../../packages/harness/test/session/resume.test.ts) cover already materialized unanswered input. [The decision](../decisions/implemented/bug-fix/2026-10-26-continue-completed-roots-for-steering.md) owns the admission policy.

## Lessons

Foreground reply completion, execution lineage and future notification delivery are separate facts. A continuation test must cross both the time of completion and a change of task root to validate their interaction.
