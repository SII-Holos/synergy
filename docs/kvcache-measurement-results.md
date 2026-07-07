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
(pass) KV-cache measurement prompt-shape harness > production OpenAI-style layout preserves stable prefix through reusable history [0.36ms]
(pass) KV-cache measurement prompt-shape harness > production OpenAI-style layout appends volatile advisory context after history [0.06ms]
(pass) KV-cache measurement prompt-shape harness > production layout keeps tool-call history before volatile advisory context [0.06ms]
(pass) KV-cache measurement prompt-shape harness > Anthropic layout keeps the stable breakpoint before volatile advisory system blocks [0.04ms]

 4 pass
 0 fail
 8 expect() calls
Ran 4 tests across 1 file. [28.00ms]
```

## Evidence captured

- Production OpenAI-style layout preserves the stable system plus reusable history prefix when volatile advisory context changes.
- Production OpenAI-style layout appends volatile advisory context after reusable history.
- Production layout keeps tool-call and tool-result history before volatile advisory context.
- Anthropic layout keeps the stable cache breakpoint before volatile advisory system blocks.

## Live provider experiments

Live provider experiments were not executed during the measurement-harness Blueprint step or the later validation step.

Validation-step rationale:

- The implemented production layout is already covered by deterministic production helper tests plus the synthetic prompt-shape harness, which directly prove the cacheability invariant without provider spend or current-runtime interference.
- Running a second live Synergy instance would require copying provider config into an isolated `SYNERGY_HOME`; that is feasible via `docs/kvcache-measurement-harness.md`, but it adds credential-handling and long-running-process risk that is not necessary for pre-PR validation.
- Provider-reported cache metadata is route/model dependent and may be unavailable or delayed; absence of live cached-token metadata would not invalidate the deterministic layout proof.
- `docs/kvcache-measurement-harness.md` remains the safe procedure for a later manual OpenAI-Codex/DeepSeek experiment if maintainers want provider-billed token evidence before or after merge.
