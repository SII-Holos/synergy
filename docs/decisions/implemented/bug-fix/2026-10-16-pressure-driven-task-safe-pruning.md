# Decision Record: Pressure-driven task-safe tool-output pruning

Status: implemented

## Problem

Independent background pruning rewrites retained model history when eligible output exceeds fixed batch thresholds, regardless of the current model window. Counting visible user-role messages as protected turns also lets Cortex completion notices and steer input age evidence within one active task. The provider-input calibration cannot subtract output removed before its anchor, so reusing that baseline after pruning can immediately request an unnecessary summary. The [incident analysis](../../../postmortem/0076-tool-pruning-aged-active-task-evidence.md) records the observed behavior and measurement limits.

## Decision

`SessionInvoke` uses the existing `PromptBudgeter` soft-pressure and hard-overflow decisions to admit synchronous pruning before automatic summary injection. `SessionCompaction.selectPartsToPrune()` protects the two latest prompt-visible canonical task roots, retaining the existing output thresholds, completed-summary cutoff, already-pruned checks and protected tools. Notifications and non-root user input cannot move this protection. The per-step background pruning registration is removed.

Pruning persists ordinary tool-part timestamps from the canonical loop snapshot and returns the committed updates. Message transforms receive isolated mutable object containers, sharing immutable strings to avoid copying large output payloads on every step. This applies to ordinary calls and remote-compaction reconstruction; even in-place nested mutations cannot reach canonical parts. The current request merges only committed pruning timestamps into its separate transformed snapshot, rebuilds workflow/model projection and the final plan, and performs full measurement without the previous provider calibration. Optional assistant `metadata.promptPruning` freezes a diagnostic digest of retained pruned-part identities and timestamps for the request. Calibration now verifies the complete prepared envelope and message prefix under the [explicit compaction coverage decision](2026-10-26-compaction-prefix-coverage.md); historical usage alone is not a valid baseline. Assistant creation time is not used to infer the later request's contents. The open metadata schema, export/import and ordinary message persistence preserve this derived proof without a historical rewrite or schema migration. Insufficient relief keeps the existing summary and hard-overflow paths. `compaction.auto` and `compaction.prune` remain independent; first-result truncation, model limits and configuration defaults are unchanged.

The sequence is informed by [DeepSeek Harness's pressure-triggered pruning](https://github.com/deepseek-ai/deepseek-harness/blob/86a402200d95fecef4529d969836f1fe13c6cb0d/packages/compaction/compaction-basic/src/index.ts#L289-L327). Synergy reuses its own budgeter, canonical task identities, artifact-backed output and provider replay instead of adopting that implementation or its character head/tail policy. The [real invocation regressions](../../../../packages/harness/test/session/pruning-invoke.test.ts) inspect actual SDK input, persistence and summary behavior; [selector and cancellation tests](../../../../packages/harness/test/session/compaction.test.ts) and [calibration tests](../../../../packages/harness/test/session/prompt-budgeter-calibration.test.ts) cover the lower-level invariants.

## Alternatives considered

**Increase the 40k protected-output or 20k minimum-batch constants.** This delays the same pressure-independent mutation and does not correct task ownership. The diagnostic samples do not identify an optimal replacement value.

**Disable pruning.** This preserves the prefix until summary compaction but retains all eligible raw output. Long-task capacity still requires a reduction path, and disabling a configured mechanism is unnecessary to fix admission and ownership.

**Replace every pressure event with a summary.** This skips a deterministic reduction that can already relieve pressure without another model call. The existing summarizer remains the fallback when recent-task protection or insufficient eligible output prevents relief.

**Prune in the background after detecting pressure.** The request being admitted can still contain the old output, and later calibration can still include it. Synchronous writes and a same-request rebuild make the reduced plan the one that is measured and sent.

## Consequences

No-pressure requests retain their prior tool-result prefix. Pruning still changes that prefix when space reduction is required; the change does not claim to eliminate cache misses or prove provider cost savings. A pressure event adds deterministic tool-part writes and full measurement to preparation. A task whose protected evidence alone exceeds the window still uses normal compaction. Partial writes from a storage failure or cancellation are not rolled back; canonical evidence stays retained, the invocation must not dispatch the obsolete prompt, and subsequent preparation observes the committed timestamps. Historical pruned outputs are not restored or migrated.
