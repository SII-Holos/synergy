# Synergy KV-cache measurement results

This result artifact is for BlueprintLoop `bll_f3cf8e8560012N4WeGvzpDIifC`.

## Command

Run from `packages/synergy`:

```bash
bun test test/session/kvcache-measurement.test.ts
```

## Result

```text
bun test v1.3.14 (0d9b296a)

test\session\kvcache-measurement.test.ts:
(pass) KV-cache measurement prompt-shape harness > production OpenAI-style layout preserves stable prefix through reusable history [1.68ms]
(pass) KV-cache measurement prompt-shape harness > production OpenAI-style layout appends volatile advisory context after history [0.18ms]
(pass) KV-cache measurement prompt-shape harness > production DeepSeek layout preserves stable prefix through reusable history [0.24ms]
(pass) KV-cache measurement prompt-shape harness > production layout keeps tool-call history before volatile advisory context [0.15ms]
(pass) KV-cache measurement prompt-shape harness > Anthropic layout keeps the stable breakpoint before volatile advisory system blocks [0.13ms]

 5 pass
 0 fail
18 expect() calls
Ran 5 tests across 1 file. [1373.00ms]
```

## Evidence captured

- Production OpenAI-style layout preserves the stable system plus reusable history prefix when volatile advisory context changes.
- Production OpenAI-style layout appends volatile advisory context after reusable history.
- Production DeepSeek layout preserves the same stable system plus reusable history prefix when volatile advisory context changes.
- Production layout keeps tool-call and tool-result history before volatile advisory context.
- Anthropic layout keeps the stable cache breakpoint before volatile advisory system blocks.

## Live provider experiments

Live provider experiments were executed during PR audit with isolated runtime homes and real Synergy CLI invocations.

Experiment shape:

- Baseline: `origin/dev`; candidate: this PR branch.
- Agent: `synergy-max`.
- Session shape: one session per branch/model/repeat, four consecutive user turns in that same session.
- Tool shape: every user turn was required to execute at least three real tool calls.
- Branch order alternated by repeat to reduce warm-cache/order bias.
- Models: `openai-codex/gpt-5.3-codex-spark`, `deepseek/deepseek-v4-flash`, and `deepseek/deepseek-v4-pro`.

All tool-heavy runs completed successfully: the initial three-model run completed 48/48 turns, and the focused DeepSeek follow-up completed 32/32 turns. Each turn returned the expected marker text and met the minimum tool-call threshold.

### OpenAI-Codex result

The OpenAI-Codex run showed the intended reusable-prefix effect after the first turn:

| Turn | Baseline hit % | PR hit % | Baseline miss tokens | PR miss tokens | Miss-token change |
| ---: | -------------: | -------: | -------------------: | -------------: | ----------------: |
|    2 |          88.16 |    97.60 |             10,609.0 |        2,142.5 |            -79.8% |
|    3 |          92.45 |    97.15 |             21,867.5 |       14,104.5 |            -35.5% |
|    4 |          93.45 |    94.59 |              9,397.5 |        8,854.5 |             -5.8% |

Turn 3 had more model steps and tool calls on the PR path, so total actual input tokens were higher even though provider-reported miss tokens were lower. That is expected noise for live agent runs and is why the audit records both cache hit rate and tool/model-step counts.

### DeepSeek result

The first DeepSeek live run was mixed because the branch optimized OpenAI/OpenAI-Codex/Azure layouts but left `deepseek` on the legacy pre-history system-message layout. The branch now gates DeepSeek into the same late advisory context layout while leaving generic `@ai-sdk/openai-compatible` providers conservative.

Focused follow-up results after the DeepSeek gate:

| Model                        | Turn | Baseline hit % | PR hit % | Baseline miss tokens | PR miss tokens | Miss-token change |
| ---------------------------- | ---: | -------------: | -------: | -------------------: | -------------: | ----------------: |
| `deepseek/deepseek-v4-flash` |    2 |          73.92 |    94.40 |             38,911.5 |       15,453.5 |            -60.3% |
| `deepseek/deepseek-v4-flash` |    3 |          88.99 |    96.85 |             16,687.0 |        8,176.5 |            -51.0% |
| `deepseek/deepseek-v4-flash` |    4 |          97.86 |    96.31 |              3,791.0 |        5,580.5 |            +47.2% |
| `deepseek/deepseek-v4-pro`   |    2 |          60.11 |    91.36 |             41,703.0 |        9,040.5 |            -78.3% |
| `deepseek/deepseek-v4-pro`   |    3 |          73.13 |    91.85 |             36,043.0 |       10,717.0 |            -70.3% |
| `deepseek/deepseek-v4-pro`   |    4 |          94.21 |    97.06 |              6,082.5 |        3,081.5 |            -49.3% |

DeepSeek turn 1 is not used as a benefit signal because each branch starts with a fresh session prefix. The useful signal is turns 2-4, where historical context is available for reuse.

### DeepSeek metadata smoke result

A focused July 2026 live smoke checked the metadata shape without starting a Synergy runtime:

- Raw DeepSeek chat-completion responses include `usage.prompt_cache_hit_tokens`, `usage.prompt_cache_miss_tokens`, and `usage.prompt_tokens_details.cached_tokens`.
- `@ai-sdk/openai-compatible` normalizes the hit count to `usage.cachedInputTokens` and returned an empty `providerMetadata.deepseek` object for the same request shape.
- Synergy therefore treats normalized `cachedInputTokens` as the first cache-read source, keeps provider-metadata fallbacks for existing recordings, and also accepts direct `usage.prompt_cache_*` fields for raw or future provider wrappers.

This smoke verifies the cache-token field path only. It does not replace the repeated-turn hit-rate measurements above.
