# Decision Record: Named strip_reasoning condition for enforced-thinking benchmark endpoints

Status: implemented

## Problem

Enforced-thinking endpoints (vLLM Qwen chat templates) accept but do not enforce server-side thinking controls: the optimization loop measured `thinking_budget: 1024` carried on every upstream payload while a single response streamed ~15K tokens of deliberation, and `clear_thinking: true` carried while replayed assistant history still contained full `reasoning_content` (up to 37,704 characters in one session). On such endpoints per-turn output volume is dominated by deliberation that is echoed back into context: the harness replays each assistant turn's reasoning, the model sees its own verbose deliberation in history, and long-horizon cells die by accumulated per-turn cost (54-cell final: 4 vs 7 passes against pi, turn economics 90s vs 36s per request).

## Decision

Replay policy belongs to the transport, not the endpoint. `ProviderTransform.message` gains a `stripReasoning` option: when set, reasoning parts are dropped from replayed assistant messages before the provider sees them, and a reasoning-only assistant turn collapses to empty string content so turn alternation survives. The provider `options` schema declares the flag ([schema.ts](../../../../packages/harness/src/config/schema.ts)), [llm.ts](../../../../packages/harness/src/session/llm.ts) forwards it from the resolved provider options next to `mergeSystemMessages`, and the option composes with the interleaved replay path: the `reasoning_content` key is preserved (DeepSeek-class endpoints require the key on assistant turns) with the deliberation text emptied.

The benchmark evaluator exposes the matching Synergy-only named condition `harnesses.<name>.strip_reasoning` ([config.py](../../../../benchmark/src/synergy_bench/config.py), [harnesses.py](../../../../benchmark/src/synergy_bench/harnesses.py), [runner.py](../../../../benchmark/src/synergy_bench/runner.py)), mirroring the `merge_system_messages` contract: explicit boolean, wrong-axis use rejected, forwarded at both the freeze-time and dispatch-time generation sites. The paired [iteration preset](../../../../benchmark/configs/qwen38-iter-r6.yaml) runs plain and strip arms interleaved on the same endpoint window so the comparison is drift-free.

Provenance: the loop record in [PR #1421](https://github.com/SII-Holos/synergy/pull/1421) — R1 confirmed the ~3× output-volume gap versus pi, R2 falsified the persona hypothesis, R3 falsified `thinking_budget` (accepted, unenforced), R5 falsified `clear_thinking` (accepted, unenforced), R4 proved `enable_thinking` is the enforced server-side lever at a −91% output cost with a pass-rate ceiling. The transform test pins the default, the strip behavior, the reasoning-only collapse, and the interleaved empty-replay contract ([transform.test.ts](../../../../packages/harness/test/provider/transform.test.ts)).

## Alternatives considered

**Fix it server-side via `chat_template_kwargs`.** Falsified live: the deployment accepts both `thinking_budget` and `clear_thinking` without enforcing either. Client-side stripping is the only layer that measurably changes the request.

**Disable thinking entirely (`enable_thinking: false`).** Measured in R4: output collapses 91% and every cell reaches a terminal verdict, but the pass face went to zero — the cheapest form loses the only form that passes quality gates. Stripping keeps live deliberation and removes only its replay.

**Strip unconditionally for all providers.** Rejected: several providers require reasoning replay for coherence (interleaved contracts key on it), so the behavior must be an explicit per-provider option defaulting to off.

## Consequences

The condition is frozen per experiment and reported on the harness axis; omitted cells keep the native replay shape, so historical runs remain read-only and comparable. Because stripping changes what the model conditions on, quality effects are measured, not assumed: the paired R6 matrix grades pass retention (openssl canary), per-request output reduction, and long-horizon timeout conversion in one drift-free window.
