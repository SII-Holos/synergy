# Synergy KV-cache validation result

This result artifact is for BlueprintLoop `bll_f3d1740e8001HAqUPHwU6Fnxwr`.

## Decision

The KV-cache optimization is ready for Step 8 documentation, commit, and PR packaging after deterministic tests and live provider experiments.

The validation blockers from audit were resolved:

- `packages/synergy/test/session/invoke.test.ts` verifies the coauthor reminder in `lateSystem`, where the optimized prompt layout intentionally places advisory runtime content.
- `docs/kvcache-measurement-results.md` references the current production prompt-layout test names and live provider evidence.
- Live OpenAI-Codex and DeepSeek experiments validate the optimization with real Synergy sessions, repeated tool calls, and provider-reported cache metadata.
- The initial DeepSeek run exposed that `deepseek` was not covered by the late advisory layout; the branch now routes cache-sensitive provider behavior through `PromptCachePolicy` with deterministic coverage.

## Quality gates

Commands run from `packages/synergy` unless noted:

```bash
bun run quality:quick
```

Result:

```text
format:check, lint, typecheck, monorepo:check, and package:check passed
```

```bash
bun test test/session/kvcache-measurement.test.ts
```

Result:

```text
5 pass
0 fail
18 expect() calls
```

```bash
bun test test/session/plugin-system-transform.test.ts test/session/kvcache-measurement.test.ts
```

Result:

```text
15 pass
0 fail
50 expect() calls
```

```bash
bun test --timeout 30000 test/session/plugin-system-transform.test.ts test/session/kvcache-measurement.test.ts test/provider/transform.test.ts test/session/compaction.test.ts test/session/invoke.test.ts
```

Result:

```text
167 pass
0 fail
351 expect() calls
```

Prior validation in this Blueprint also completed successfully:

- Focused cache suites: 147 tests, 0 failures.
- `bun run typecheck`: 10/10 packages, 0 errors.
- Root `bun run format:check`: all Prettier checks passed.
- Root `bun run lint`: oxlint 0 warnings, 0 errors.

## Live experiment decision

Live provider experiments were run during PR audit.

The safe live experiment runbook in `docs/kvcache-measurement-harness.md` was used as the shape for an isolated local audit: separate runtime homes, copied provider configuration/auth state, and non-shared sessions/workspaces for baseline and PR runs.

Run shape:

- Baseline: `origin/dev`.
- Candidate: this PR branch.
- Agent: `synergy-max`.
- Models: `openai-codex/gpt-5.3-codex-spark`, `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-pro`.
- Session shape: four consecutive user turns in the same session for each branch/model/repeat.
- Tool shape: each user turn was required to execute at least three real tool calls.
- Ordering: branch order alternated by repeat to reduce warm-cache/order bias.

Result summary:

- OpenAI-Codex produced 48/48 successful turns. Turns 2-4 all reduced miss tokens; turn 2 improved from 88.16% to 97.60% cache hit rate and reduced miss tokens by 79.8%.
- The initial DeepSeek run produced 48/48 successful turns but mixed cache economics because DeepSeek was still on the fallback layout.
- After adding a narrow `deepseek` provider gate, the focused DeepSeek follow-up produced 32/32 successful turns. `deepseek-v4-pro` turns 2-4 reduced miss tokens by 78.3%, 70.3%, and 49.3%; `deepseek-v4-flash` turns 2-3 reduced miss tokens by 60.3% and 51.0%, while turn 4 was roughly saturated and slightly lower by hit rate.
- No run failed due to prompt layout, tool execution, or provider metadata parsing.

## Risk review summaries

### Security and privacy

No blocker.

- Prompt-layout debug logging emits only mode/count metadata, not raw prompt text or private content.
- No memory bodies, environment bodies, git health text, user text, tool arguments, provider keys, credentials, or raw prompts are logged by the new instrumentation.
- `promptCacheKey` remains session-scoped and is not a credential path.
- Late advisory context is routed for cache layout but is not added to new persistence or logging surfaces.

### Performance and resource usage

No blocker.

- `promptMessages()` builds the provider message layout once per stream call, matching the existing prompt assembly lifecycle.
- The new metadata computation is count/boolean/string-label only and negligible compared with model invocation and token estimation.
- `PromptBudgeter` now carries and estimates `lateSystem`, so budget accounting remains conservative for the optimized layout.
- Live OpenAI-Codex and DeepSeek experiments show lower provider-reported miss tokens on the useful repeated-turn paths.

### API compatibility and public contracts

No blocker.

- `promptLayoutMetadata()` is module-private and not exported.
- `PromptLayoutInput` and `promptMessages()` are internal module-level exports used by session code and tests, not server routes, SDK schemas, config, CLI, or UI contracts.
- `lateSystem` is optional and internal to session prompt planning/rendering.
- No route, SDK, persisted schema, config field, or user-facing command changed.

### Maintainability

No blocker.

- Naming is clear: `lateSystem` and late-user-context rendering describe the optimization without adding a generic compatibility adapter.
- Responsibilities remain separated: `invoke.ts` owns prompt-layer assembly, `prompt-budgeter.ts` owns budget-plan propagation, `PromptCachePolicy` owns provider cache routing, and `llm.ts` owns message rendering.
- Tests cover the key invariants: OpenAI-style stable prefix preservation, DeepSeek stable prefix preservation, late advisory context placement, tool-call history ordering, Anthropic stable breakpoint behavior, provider cache options, cache token accounting, and invoke-level coauthor reminder placement.
- The DeepSeek route is intentionally explicit; generic `@ai-sdk/openai-compatible` providers still use the conservative fallback until verified or configured for `promptCacheKey`.

## Remaining uncertainty

The branch has no validation blocker.

Actionable remaining uncertainties for follow-up ownership:

1. **Live-agent noise** - Tool count and model-step count can differ between baseline and PR runs, so total actual input tokens are not always a clean one-to-one comparison. The strongest signal is provider-reported cache hit/miss metadata on turns 2-4, with tool/model-step counts reported alongside it.
2. **Anthropic advanced cache features** - Multi-breakpoint, TTL, diagnostics beta, and prewarming were intentionally not implemented. This remains a future optimization owned by a follow-up provider-capability design, not a blocker for the current single-breakpoint behavior.
3. **Plugin hook visibility** - `experimental.chat.system.transform` now sees the stable `system` portion, while volatile advisory layers are carried as `lateSystem`. This is intentional for cacheability and should be called out in Step 8 PR documentation/release notes if maintainers consider the hook externally relied upon.
4. **OpenAI/Azure/DeepSeek message ordering** - Late advisory context is rendered as a delimited user-role runtime context after history for OpenAI-style and DeepSeek routes. Tests cover ordering and prefix stability; Step 8 should document this intentional internal behavior change in the PR summary.

## Step 8 recommendation

Proceed to Step 8: documentation, commit, push, and PR.

The PR should include:

- Stable-prefix cache strategy and provider-specific layout summary.
- Test and quality-gate evidence above.
- Live OpenAI-Codex and DeepSeek experiment evidence.
- Remaining low-risk uncertainties, especially plugin hook scope and OpenAI/Azure/DeepSeek late-user-context ordering.
