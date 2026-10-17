# Tool pruning aged active-task evidence

## Executive summary

Tool-output cleanup repeatedly rewrote cached conversation prefixes without model-window pressure. Its recent-turn protection counted Cortex completion notices as new work, making evidence from an active task eligible after two notifications. Provider usage calibration could also remain anchored to the larger pre-pruning history. Existing tests covered output size and ordinary turns, not canonical task ownership and the final request after pressure relief.

## Summary

A read-only sample of 216 provider requests across three sessions contained 12 pruning batches affecting 647 results. Eleven batches had unchanged system instructions, tool definitions and model, with no completed summary compaction; their provider-reported cache shares were 14.1–31.9%. Pre-pruning input occupied 35.1–68.3% of the model's available input limit. These observations establish history mutation and cache discontinuities, not the exact counterfactual cost or a demonstrated task-quality failure.

## Timeline

- Compared complete, integrity-checked requests around input reductions and low cache shares, then matched every batch independently against canonical tool-part pruning timestamps.
- Found a one-root UI investigation whose two Cortex completion notices preceded pruning of 24 current-task results only 149–254 seconds old.
- Reconstructed its pre-pruning output in memory: the production selector chose the exact same 24 calls with the notices and none after removing their effect on the turn count.
- Added failing root-protection and stale-calibration tests, then exercised actual SessionInvoke SDK input through no-pressure continuation, pressure relief, configuration switches and summary fallback.
- Independent review found that shallow message copies could let in-place hook changes reach the new canonical pruning writes. A real invocation regression reproduced persisted temporary titles; isolating mutable containers before transforms fixed the regression without cloning large output strings.

## Root cause

The asynchronous pruning job is admitted by loop step and eligible output quantity, not the existing prompt-pressure decision. `Turn.countRecentTurns()` counts non-synthetic user-role messages, which include visible non-root Cortex notifications and steer input. Tool age under that rule is not task age. Pruning updates persistent parts but cannot update an already-held immutable request snapshot. Provider input calibration only adds a subsequent delta; it cannot remove older tool results included in its anchor.

## Guardrails

The [decision record](../decisions/implemented/bug-fix/2026-10-16-pressure-driven-task-safe-pruning.md) owns the admission and ownership choices. [Real invocation tests](../../packages/harness/test/session/pruning-invoke.test.ts) verify stable low-pressure prefixes, soft/hard pressure relief, independent pruning/summary switches, canonical evidence isolation under replacement and in-place transforms, pause/error settlement, post-pruning tool continuation and compaction fallback. [Message tests](../../packages/harness/test/session/message-v2.test.ts) verify nested mutable isolation and metadata preservation. [Selector tests](../../packages/harness/test/session/compaction.test.ts) exercise same-root notifications, genuine later roots, cancellation and snapshot immutability. [Calibration tests](../../packages/harness/test/session/invoke-calibration.test.ts) reject mismatched or unverified pruning revisions and accept usage recorded by the first reduced request, even when its assistant was created before pruning.

## Lessons

Transport roles do not define task identity. A model working-set mutation requires an updated projection and an invalidated usage baseline before admission. Measure total input, uncached input and continuation correctness together; a shorter prompt or lower cache share alone cannot establish an overall improvement.
