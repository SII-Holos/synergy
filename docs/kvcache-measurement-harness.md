# Synergy KV-cache measurement harness

This artifact is for BlueprintLoop `bll_f3cf8e8560012N4WeGvzpDIifC`.

## 1. Inputs and purpose

Inputs:

- `docs/kvcache-baseline-report.md`
- `docs/kvcache-best-practices-research.md`
- `docs/kvcache-strategy-design.md`

Purpose:

- Provide a repeatable deterministic measurement path before production cache optimization.
- Prove prompt-shape invariants without live provider calls.
- Provide Windows-safe isolated runtime instructions for optional live Synergy experiments.
- Capture proxy metrics for cacheability: common prefix stability, region ordering, and expected token/cost implications.

## 2. Deterministic measurement model

The deterministic harness lives at:

- `packages/synergy/test/session/kvcache-measurement.test.ts`

It models synthetic prompt regions instead of real private prompts:

| Region                | Purpose                                   | Volatility                   |
| --------------------- | ----------------------------------------- | ---------------------------- |
| `core_system`         | built-in agent/provider instructions      | stable                       |
| `project_system`      | AGENTS/project instructions               | stable                       |
| `permission_system`   | permission/governance context             | stable, Anthropic breakpoint |
| `history:*`           | reusable prior user/assistant messages    | append-only stable           |
| `memory_context`      | recalled memory/experience                | volatile across user turns   |
| `environment_context` | env/time/git/agenda/planning-like context | volatile                     |
| `current_user`        | current turn user input                   | volatile                     |

The test intentionally avoids real prompts, secrets, runtime state, credentials, local config, or user data.

## 3. Metrics and expected invariants

Metrics captured by the deterministic tests:

- `commonPrefixLength(a, b)`: exact character prefix shared by two consecutive-turn prompt strings.
- `regions`: rendered region ordering.
- `breakpointRegion`: Anthropic cache-control marker proxy.
- `historySpan`: deterministic character span contributed by reusable historical messages.

Expected invariants:

1. Legacy OpenAI-style layout places volatile `memory_context` and `environment_context` before `history`, so changing volatile content causes common prefix to end before reusable history.
2. Target OpenAI-style layout places reusable history before volatile context, so the common prefix includes stable system plus reusable history.
3. Target layout increases deterministic cacheable prefix by at least the historical message span in the synthetic fixture.
4. Anthropic breakpoint remains at `permission_system` and excludes volatile memory/env regions by default.

These are proxy metrics, not provider-reported cached token measurements. They are sufficient to prove prompt-shape cacheability invariants before production implementation.

## 4. Windows isolated runtime instructions

Use these instructions only for optional live experiments. They are intentionally not executed by default in this Blueprint because deterministic evidence is the reliable fallback and avoids current-agent runtime interference.

PowerShell example with a unique external temp runtime home:

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$envHome = Join-Path $env:TEMP "synergy-kvcache-$stamp"
New-Item -ItemType Directory -Force -Path $envHome | Out-Null

# Optional: copy only config so providers are available.
# Do not copy sessions, runtime databases, logs, or secrets into the repository.
$configSource = Join-Path $HOME ".synergy\config"
$configDest = Join-Path $envHome ".synergy\config"
if (Test-Path $configSource) {
  New-Item -ItemType Directory -Force -Path (Split-Path $configDest) | Out-Null
  Copy-Item -Recurse -Force $configSource $configDest
}

$env:SYNERGY_HOME = $envHome
bun dev web --server-port 4097 --app-port 3001
```

PowerShell example scoped to one process without permanently modifying the parent shell:

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$envHome = Join-Path $env:TEMP "synergy-kvcache-$stamp"
New-Item -ItemType Directory -Force -Path $envHome | Out-Null
cmd /c "set SYNERGY_HOME=$envHome&& bun dev send \"KV cache measurement smoke prompt\""
```

Worktree-local temp alternative:

```powershell
$repo = "C:\Eric\projects\synergy\.synergy\worktrees\synergy-kvcache-optimization-0c3346"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$envHome = Join-Path $repo ".tmp\synergy-kvcache-$stamp"
New-Item -ItemType Directory -Force -Path $envHome | Out-Null
$env:SYNERGY_HOME = $envHome
bun dev web --server-port 4097 --app-port 3001
```

Cleanup:

```powershell
Remove-Item -Recurse -Force $envHome
Remove-Item Env:\SYNERGY_HOME -ErrorAction SilentlyContinue
```

Safety rules:

- Never reuse the current agent process runtime home for child Synergy experiments.
- Use non-conflicting ports such as server `4097` and app `3001`.
- Do not copy runtime sessions or database files.
- Do not commit copied config or credentials.
- Keep any copied config outside tracked repo paths, or under ignored `.tmp/` only if necessary.

## 5. Live experiment plan/result or fallback rationale

Live provider experiments were not executed in this Blueprint step.

Rationale:

- The step's primary purpose is to build a safe, repeatable measurement path before production optimization.
- Running a second live Synergy instance risks interfering with the current agent unless carefully isolated; the runbook above provides the required safe path for a later manual or automated experiment.
- The target production layout is not implemented yet, so live provider `cached_tokens` would only measure the current baseline, not the before/after optimization.
- Deterministic prompt-shape tests directly prove the core invariant needed for the next implementation step.

Future live experiment plan after implementation:

1. Use isolated `SYNERGY_HOME` from Section 4.
2. Run two consecutive prompts with OpenAI-Codex and/or DeepSeek using the same session.
3. Record provider metadata fields when available:
   - OpenAI: cached input tokens / `cached_tokens` equivalent.
   - DeepSeek/openai-compatible: `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`.
4. Compare baseline branch vs optimized branch:
   - stable-prefix proxy length,
   - total prompt tokens,
   - cached tokens or hit/miss metadata,
   - cost delta from Synergy usage accounting,
   - failures or provider incompatibilities.

## 6. Validation commands and results

Narrow test command:

```bash
# from packages/synergy
bun test test/session/kvcache-measurement.test.ts
```

Expected result:

```text
4 pass
0 fail
```

Actual result will be recorded by the Blueprint execution after the test runs.

## 7. Artifacts created

- `docs/kvcache-measurement-harness.md`
- `packages/synergy/test/session/kvcache-measurement.test.ts`

Existing related inputs remain:

- `docs/kvcache-baseline-report.md`
- `docs/kvcache-best-practices-research.md`
- `docs/kvcache-strategy-design.md`

## 8. Limitations and handoff to implementation

Limitations:

- Character prefix length is a deterministic proxy for provider token-prefix reuse; it is not a tokenizer-aware cached-token count.
- The harness does not call live providers and does not observe provider cache metadata in this step.
- The harness models target layout before production implementation, so it proves design invariants rather than exercising production rendering.
- Anthropic TTL, diagnostics, and prewarming are not implemented here; the test only verifies default breakpoint placement.

Handoff:

- Implementation should introduce production prompt-region rendering that satisfies the same invariants.
- Add production-level tests that call the real prompt rendering functions once they exist.
- Re-run the deterministic harness after implementation and optionally perform isolated live provider measurements with OpenAI-Codex/DeepSeek.
