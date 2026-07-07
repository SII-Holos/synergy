# Synergy KV-cache validation result

This result artifact is for BlueprintLoop `bll_f3d1740e8001HAqUPHwU6Fnxwr`.

## Decision

The KV-cache optimization is ready for Step 8 documentation, commit, and PR packaging.

The validation blockers from audit were resolved:

- `packages/synergy/test/session/invoke.test.ts` now verifies the coauthor reminder in `lateSystem`, where the optimized prompt layout intentionally places advisory runtime content.
- `docs/kvcache-measurement-results.md` now references the current production prompt-layout test names rather than the pre-production legacy/target fixture names.
- This file records the explicit live-experiment decision, remaining uncertainty, risk summaries, and readiness recommendation required by the validation Blueprint.

## Quality gates

Commands run from `packages/synergy` unless noted:

```bash
bun test test/session/invoke.test.ts
```

Result:

```text
18 pass
0 fail
54 expect() calls
```

```bash
bun test test/session/plugin-system-transform.test.ts test/session/kvcache-measurement.test.ts test/provider/transform.test.ts test/session/compaction.test.ts test/session/invoke.test.ts
```

Result:

```text
165 pass
0 fail
344 expect() calls
```

Prior validation in this Blueprint also completed successfully:

- Focused cache suites: 147 tests, 0 failures.
- `bun run typecheck`: 10/10 packages, 0 errors.
- Root `bun run format:check`: all Prettier checks passed.
- Root `bun run lint`: oxlint 0 warnings, 0 errors.

Targeted formatting after the audit fixes:

```bash
bunx prettier --check docs/kvcache-measurement-results.md packages/synergy/test/session/invoke.test.ts
```

Result: all matched files use Prettier style.

## Live experiment decision

No live provider experiment was run during this validation step.

The safe live experiment runbook in `docs/kvcache-measurement-harness.md` was reviewed. It requires an isolated runtime home, non-conflicting ports, and careful provider config handling before launching a second Synergy process. That path is available for later maintainer-run provider-billed measurement, but it is not warranted for this pre-PR validation pass.

Rationale:

- The deterministic production helper tests exercise the implemented `LLM.promptMessages()` layout directly and prove the cacheability invariant that matters before merge: OpenAI-style providers keep stable system content plus reusable history before volatile advisory context.
- Provider-reported cached-token metadata is model/route dependent and may be unavailable, delayed, or noisy; a live run without cache metadata would not invalidate the deterministic prompt-shape proof.
- Running a second Synergy instance would require copying provider config into an isolated `SYNERGY_HOME`, which adds credential-handling and long-running-process risk without changing the correctness conclusion.
- The validation goal is to prove layout correctness and risk posture, not to produce billed provider economics. `docs/kvcache-measurement-harness.md` remains the owner-approved procedure for a later OpenAI-Codex/DeepSeek measurement if maintainers want provider metadata before or after merge.

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
- The cacheability benefit is decisive for OpenAI-style routes because volatile advisory context no longer breaks the stable system plus reusable-history prefix.

### API compatibility and public contracts

No blocker.

- `promptLayoutMetadata()` is module-private and not exported.
- `PromptLayoutInput` and `promptMessages()` are internal module-level exports used by session code and tests, not server routes, SDK schemas, config, CLI, or UI contracts.
- `lateSystem` is optional and internal to session prompt planning/rendering.
- No route, SDK, persisted schema, config field, or user-facing command changed.

### Maintainability

No blocker.

- Naming is clear: `lateSystem` and late-user-context rendering describe the optimization without adding a generic compatibility adapter.
- Responsibilities remain separated: `invoke.ts` owns prompt-layer assembly, `prompt-budgeter.ts` owns budget-plan propagation, and `llm.ts` owns provider-specific message rendering.
- Tests cover the key invariants: OpenAI-style stable prefix preservation, late advisory context placement, tool-call history ordering, Anthropic stable breakpoint behavior, provider cache options, cache token accounting, and invoke-level coauthor reminder placement.
- The `buildCalibration` comment documents the deliberate cheap heuristic tradeoff.

## Remaining uncertainty

The branch has no validation blocker.

Actionable remaining uncertainties for follow-up ownership:

1. **Live provider economics** — Provider-reported cached-token savings were not measured in this validation step. Maintainers can run the isolated procedure in `docs/kvcache-measurement-harness.md` if they want billed OpenAI-Codex or DeepSeek cache metadata before or after merge. This is low risk because deterministic production tests prove the prompt layout invariant independent of provider telemetry availability.
2. **Anthropic advanced cache features** — Multi-breakpoint, TTL, diagnostics beta, and prewarming were intentionally not implemented. This remains a future optimization owned by a follow-up provider-capability design, not a blocker for the current single-breakpoint behavior.
3. **Plugin hook visibility** — `experimental.chat.system.transform` now sees the stable `system` portion, while volatile advisory layers are carried as `lateSystem`. This is intentional for cacheability and should be called out in Step 8 PR documentation/release notes if maintainers consider the hook externally relied upon.
4. **OpenAI/Azure message ordering** — Late advisory context is rendered as a delimited user-role runtime context after history for OpenAI-style routes. Tests cover ordering and prefix stability; Step 8 should document this intentional internal behavior change in the PR summary.

## Step 8 recommendation

Proceed to Step 8: documentation, commit, push, and PR.

The PR should include:

- Stable-prefix cache strategy and provider-specific layout summary.
- Test and quality-gate evidence above.
- No-live-experiment rationale and the future isolated live experiment procedure.
- Remaining low-risk uncertainties, especially plugin hook scope and OpenAI/Azure late-user-context ordering.
