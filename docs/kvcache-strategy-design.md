# Synergy KV-cache strategy design

This design artifact is for BlueprintLoop `bll_f3cf3d4980017lY5VWNQlp1EKh`.

## 1. Inputs and design goals

Authoritative inputs:

- `docs/kvcache-baseline-report.md`
- `docs/kvcache-best-practices-research.md`

Current baseline:

- Synergy builds system prompt parts in stable-to-dynamic order, then prepends all system messages before conversation messages.
- Anthropic currently receives explicit cache control at an early stable system breakpoint.
- OpenAI/OpenAI-Codex/Azure currently get `promptCacheKey=sessionID`, but dynamic system content before messages can truncate automatic prefix caching before historical messages.
- Memory/experience is loop-stable after step 1 but recomputed across consecutive user turns.
- Existing usage accounting already records cache read/write/miss tokens, but lacks prompt-region stability diagnostics.

Design goals for this branch:

1. Preserve correctness and trust boundaries before optimizing cache hits.
2. Make prompt regions explicit enough to test stability and provider layout decisions.
3. Improve OpenAI/openai-compatible cross-turn prefix cacheability by preventing volatile context from unnecessarily preceding reusable history where safe.
4. Improve Anthropic cacheability with provider-native breakpoint/TTL/diagnostics policy without overfitting to a single provider.
5. Keep implementation small and reversible: prompt assembly, provider option wiring, deterministic tests, and safe observability only.

Out of branch scope:

- Local GPU KV-cache engine implementation.
- Semantic response caching for correctness-critical assistant outputs.
- Full compaction redesign beyond cache-aware metadata/tests.
- Production UI dashboards unless later implementation exposes already-needed data.

## 2. Prompt-region taxonomy

The implementation should introduce an internal prompt-region model before provider-specific rendering. A region is a structured prompt segment with stability, authority, and provider-placement metadata. It does not need to become a public API.

| Region                 | Examples                                                                                         | Stability                        | Authority                                          | Movement rule                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `core_system`          | built-in agent prompt, provider preamble                                                         | release/config stable            | system/developer authority                         | Must remain before all messages for every provider                                                                 |
| `project_system`       | AGENTS.md/custom instructions                                                                    | project/session stable           | system/developer authority                         | Must remain before all messages; cacheable                                                                         |
| `permission_system`    | control profile, permission/sandbox guidance, trust boundaries                                   | session/profile stable           | system authority                                   | Must remain before all messages; never summarized                                                                  |
| `tool_schema`          | tool definitions, structured output schemas, MCP/plugin tools                                    | stable unless capability changes | provider tool contract                             | Must be deterministic and before messages according to provider SDK                                                |
| `run_contract`         | Lattice/Blueprint/Cortex execution contract, plan mode rules                                     | run/loop stable to semi-stable   | system authority                                   | Default keep before messages; may get separate Anthropic short-TTL breakpoint; do not move later until proven safe |
| `memory_context`       | recalled memory/experience                                                                       | loop-stable, cross-turn volatile | advisory context with metadata side effects        | Candidate for late dynamic context for OpenAI-style routes; keep content visible and metadata persisted            |
| `environment_context`  | env block, date/time, workspace path, git health, coauthor, agenda countdown, planning reminders | volatile                         | mostly contextual/advisory, some workflow-critical | Candidate for late dynamic context where authority permits; volatile by default                                    |
| `history`              | prior user/assistant/tool messages                                                               | append-only until compaction     | conversational state                               | Preserve canonical order and semantics; maximize reuse for OpenAI-style routes                                     |
| `current_turn_context` | late dynamic context bundle for current model call                                               | volatile                         | provider-specific role                             | Render after reusable history for OpenAI-style routes when safe                                                    |
| `observability`        | stable-prefix hash, region IDs, token estimates                                                  | metadata only                    | none                                               | Never sent to model unless explicitly safe; never raw prompt logging                                               |

### Movement classification

Safe to move later for OpenAI-style routes after focused tests:

- memory/experience content, if still injected in every relevant call and user-message metadata persistence remains unchanged.
- env/date/time/workspace/git-health/coauthor/agenda/planning reminders when rendered as a clear current-turn context block.
- cache diagnostics instructions that are not authority-bearing.

Not safe to move later in this branch:

- permission/governance/control-profile context.
- tool definitions or tool schemas.
- core agent/system prompt and AGENTS/project instructions.
- Lattice/Blueprint/Cortex run contract, unless a later design proves an equivalent system-authority channel after history for the provider.

Provider-sensitive:

- OpenAI developer/system role support and multiple developer/system message behavior.
- openai-compatible providers that mimic metadata but not OpenAI role semantics.
- Anthropic content-block cache-control placement.

## 3. Target provider layouts

### 3.1 Anthropic / Claude direct

Anthropic supports explicit breakpoint semantics, so the primary design should preserve authoritative ordering and mark cache boundaries rather than moving volatile content after messages.

Target logical order:

```text
tools/tool_schema                         cacheable, deterministic
core_system                               cacheable, long-lived
project_system                            cacheable, long-lived
permission_system                         cacheable, long-lived
[cache breakpoint A: 5m default or 1h policy]
run_contract                              semi-stable, optional short-TTL/cache breakpoint B
memory_context                            loop-stable, cross-turn volatile
environment_context                       volatile
history                                   canonical messages
current user / tool loop continuation
```

Breakpoint policy:

- Breakpoint A: after `permission_system`. This preserves the current safe baseline and keeps governance in the stable cached prefix.
- Optional breakpoint B: after `run_contract` only when run contract is stable for the current loop and token size justifies it. Default off for initial implementation unless tests demonstrate stable output.
- Do not put breakpoints on `memory_context` or `environment_context` by default because they are cross-turn volatile.
- Do not attempt to cache message history for Anthropic until volatile system regions are separated or the provider layout supports an additional message-history breakpoint without including volatile blocks.

TTL policy:

- Default `ephemeral` 5-minute TTL for tight tool loops.
- Add config/model option for `1h` TTL, but initial branch may expose only internal wiring plus tests if full config is too large.
- If mixed TTLs are later implemented, longer TTL breakpoints must precede shorter TTL breakpoints.

Diagnostics/prewarming:

- Anthropic cache diagnostics should be opt-in debug metadata only.
- Prewarming should be deferred from the first implementation; document as future work because it has direct cost and cadence tradeoffs.

Bedrock/OpenRouter Anthropic routes:

- Reuse the Anthropic logical policy only when model/provider detection confirms Anthropic/Claude semantics.
- Keep provider-specific option keys: Bedrock `cachePoint`, OpenRouter/Anthropic `cacheControl`.
- If route capability is uncertain, fall back to the current single early breakpoint or no explicit cache option rather than sending unsupported fields.

### 3.2 OpenAI / OpenAI-Codex / Azure OpenAI

OpenAI-style providers need one contiguous identical prefix. The target layout should move volatile context out from between stable system and reusable history where correctness permits.

Target logical order:

```text
tools/tool_schema                         stable, deterministic
core_system                               stable
project_system                            stable
permission_system                         stable
essential run_contract                    stable/authority; keep before history
history prefix                            prior append-only messages
current_turn_context                      memory + env + git + agenda + planning + non-authority dynamic context
current user / latest task continuation   current volatile user input
```

Key design decision:

- Do not move permission/governance/tool/core instructions.
- Keep Lattice/Blueprint/Cortex run contracts before history for the initial implementation because they are authority-bearing. This means these contracts may still limit cache reuse when they change, but correctness is more important.
- Move memory/experience and environment/time/git/agenda/planning into a late `current_turn_context` for OpenAI-style routes if tests show behavior remains equivalent enough.

Late context rendering options, in order of preference:

1. Provider-supported developer/system message after history, if the provider supports multiple developer/system messages and the SDK preserves order. This best preserves instruction strength.
2. Synthetic user-context message immediately before the latest user/task message, clearly delimited as system-provided context, only for advisory non-governance content.
3. Fallback to current pre-history system layout for providers that do not safely support late dynamic context.

The first implementation should choose the safest small path:

- Build late context support only for volatile advisory regions (`memory_context`, `environment_context`) and route it through a role supported by the provider adapter.
- Gate it behind the provider cache policy router rather than applying it to all providers.

OpenAI-Codex:

- Keep `promptCacheKey=sessionID` and existing Codex header bridge.
- Use the same OpenAI-style prompt layout only if Codex backend accepts the chosen late context role.
- If Codex role support is uncertain, use deterministic measurement harness before enabling by default.

Azure:

- Treat like OpenAI for cache key and prompt layout when SDK/provider option support is equivalent.

### 3.3 DeepSeek / openai-compatible

DeepSeek/openai-compatible routes may expose OpenAI-like cache hit/miss metadata, but behavior varies.

Target policy:

- Use the OpenAI-style layout for DeepSeek and other providers/models only when they have an explicit capability flag or known-compatible SDK behavior.
- Continue to read hit/miss metadata as today.
- Do not send OpenAI-specific retention/cache-key fields to generic openai-compatible providers unless capability metadata says it is safe.
- Measurement harness should include DeepSeek if configured, because the user indicated DeepSeek is available.

### 3.4 Compatibility fallback

Every provider should have a safe fallback:

```text
tools
all system regions in current order
messages
```

Fallback is required when:

- provider rejects late system/developer messages,
- model template requires a single system message,
- role support is unknown,
- dynamic context contains authority-bearing instructions that cannot be safely late-bound,
- tests or live experiment show behavior regressions.

## 4. Provider options and config/API design

### 4.1 Internal capability flags

Add an internal provider/model capability descriptor. This may initially live in provider transform logic or model/provider config, but should be explicit rather than inferred everywhere.

Suggested fields:

```ts
interface PromptCacheCapabilities {
  mode: "none" | "anthropic-explicit" | "openai-prefix" | "openai-compatible-prefix"
  supportsPromptCacheKey?: boolean
  supportsPromptCacheRetention?: boolean
  supportsLateDeveloperContext?: boolean
  supportsAnthropicDiagnostics?: boolean
  supportsAnthropicTTL?: boolean
}
```

Initial derivation can be conservative:

- OpenAI/OpenAI-Codex/Azure: `openai-prefix`, cache key true, retention only if verified with SDK.
- Anthropic/Claude: `anthropic-explicit`, TTL true, diagnostics opt-in true for direct Anthropic only.
- DeepSeek: `openai-compatible-prefix`, late context true after live verification, special options false.
- Other openai-compatible providers: `openai-compatible-prefix`, but late context and special options false unless verified.
- Unknown providers: `none`.

### 4.2 OpenAI options

Keep:

- `promptCacheKey=sessionID` by default.
- `store=false` where currently needed.

Add/evaluate:

- provider/model option for `prompt_cache_retention`, exposed internally as `promptCacheRetention?: "in_memory" | "24h"` or a provider-native name after SDK verification.
- default retention should remain provider default until model capability and privacy/ZDR behavior are understood.
- cache key granularity should default to session ID; future config may allow `session`, `scope`, `project`, or hashed bucket.

Do not:

- set retention for unsupported models.
- use raw user/project paths as cache keys; if broader keys are added, hash/sanitize them.

### 4.3 Anthropic options

Add/evaluate:

- `cacheControl.ttl?: "5m" | "1h"` for Anthropic where SDK supports it.
- internal breakpoint descriptors rather than a single `systemCacheBreakpoint` integer long-term.
- opt-in diagnostics:
  - beta header/config flag,
  - previous message ID tracking if supported,
  - record miss reason metadata only.

Prewarming stance:

- Defer implementation in this branch unless measurement proves high benefit.
- If later added, it must be explicit/opt-in and budget-aware.

### 4.4 Config/API shape

Minimal branch scope:

- Prefer internal capability constants and provider options over public config in the first implementation.
- Add public config only if a behavior must be user-tunable to avoid cost/privacy surprises, e.g. Anthropic 1h TTL or OpenAI 24h retention.

Potential config domain if needed later:

```jsonc
// 20-providers.jsonc or 10-models.jsonc model/provider override
{
  "prompt_cache": {
    "layout": "auto", // auto | legacy | openai-prefix | anthropic-explicit
    "openai_retention": "provider_default", // provider_default | in_memory | 24h
    "anthropic_ttl": "5m", // 5m | 1h
    "diagnostics": false,
  },
}
```

Initial implementation should not require migration if defaults preserve existing behavior for unsupported providers.

## 5. Correctness invariants

### 5.1 Permission and governance

- Permission/control-profile context remains system-authority content before history.
- It must never be moved into advisory user context.
- It must never be summarized, compacted, or omitted for cacheability.
- Observability must not log secrets or raw permission-protected prompt text.

### 5.2 Memory and experience

- Memory/experience retrieval behavior and metadata persistence remain unchanged.
- If memory content moves to a late region for OpenAI-style providers, the content must still be present on every call where it is currently present.
- `cacheResult(...)`, `getCachedResult(...)`, and injection metadata semantics remain intact.
- Memory content is advisory context; it must not be promoted to governance authority.

### 5.3 Tool visibility and tool IDs

- Active tool IDs and tool execution permissions remain unchanged.
- Provider tool schemas remain deterministic and stable when capability set is unchanged.
- Tool availability should not be changed merely to improve cache hits.
- If allowed-tool metadata is later used, it must not expose tools the session should not call.

### 5.4 System authority and run contracts

- Core agent prompt, AGENTS/project instructions, and provider/system preamble remain before messages.
- Lattice/Blueprint/Cortex contracts remain system-authority in this branch.
- If future work moves any run-contract content later, it requires explicit tests and audit because it changes instruction hierarchy.

### 5.5 Compaction and persistence

- Canonical `MessageV2` semantics remain unchanged: root/visibility/includeInContext/origin semantics are not redefined.
- Persisted session history format does not change in this design.
- Compaction may reset provider prefix cache; that is acceptable but should be observable and intentional.
- Governance/permission context must be pinned outside any lossy compaction.

### 5.6 Privacy and observability

- Cache diagnostics may include hashes, token counts, region names, provider miss reason enums, and cost estimates.
- Cache diagnostics must not include raw prompt text, memory content, secrets, credentials, or raw file paths when those can be sensitive.
- Cache keys must be stable but privacy-safe; hash broader identifiers before using them in provider routing keys.

## 6. Minimal implementation plan

### 6.1 Owning modules likely to change

Primary:

- `packages/synergy/src/session/invoke.ts`
  - build prompt regions instead of a flat `systemParts`-only model,
  - classify memory/env/git/agenda/planning as late volatile candidates,
  - preserve existing metadata and cleanup behavior.

- `packages/synergy/src/session/prompt-budgeter.ts`
  - carry prompt-region layout metadata through budgeting,
  - keep current token-budget behavior stable,
  - support deterministic tests for region order.

- `packages/synergy/src/session/llm.ts`
  - render provider-specific prompt layouts before AI SDK call,
  - preserve base system prepending,
  - pass richer cache-boundary metadata to `ProviderTransform`.

- `packages/synergy/src/provider/transform.ts`
  - convert single breakpoint to provider-aware cache controls,
  - add Anthropic TTL/diagnostics option wiring if chosen,
  - preserve existing OpenAI/Azure/Codex cache key behavior and add retention only after SDK verification.

Secondary:

- `packages/synergy/src/provider/provider.ts`
  - expose capability derivation or model/provider option parsing.

- `packages/synergy/src/session/index.ts`
  - only if additional cache observability fields are stored with messages.

- tests under `packages/synergy/test/session/` and `packages/synergy/test/provider/`.

### 6.2 First implementation slice

Implement the smallest useful slice:

1. Introduce internal prompt-region classification.
2. Add a provider-layout function that can render either:
   - legacy layout, or
   - OpenAI-prefix layout with late volatile context.
3. Keep Anthropic behavior equivalent to current single early breakpoint, but represent it through region metadata so multiple breakpoints/TTL can be added safely.
4. Preserve all current defaults unless tests enable the OpenAI-prefix layout for known-safe providers.
5. Add safe observability metadata for region order and stable-prefix token estimates if low-risk.

### 6.3 Defer from first implementation

- Public config UI.
- Anthropic prewarming.
- Deep provider-specific openai-compatible cache-key variants.
- Cache-aware compaction policy changes.
- Engine-level PIC/local KV caching.

## 7. Test and measurement plan handoff

The measurement harness step should build deterministic evidence before live provider calls.

### 7.1 Deterministic prompt-shape tests

Test cases:

1. Consecutive OpenAI-style turns with changed memory/env/time:
   - stable prefix hash remains identical through stable system + historical messages,
   - volatile context appears after reusable history,
   - current user/task remains last.

2. Same scenario under legacy layout:
   - stable prefix hash truncates before history when dynamic system changes,
   - test demonstrates expected improvement in cacheable-prefix token estimate.

3. Anthropic layout:
   - breakpoint A remains after permission/governance context,
   - volatile context has no cache-control marker by default,
   - TTL metadata appears only when configured.

4. Incompatible provider fallback:
   - provider without late-context capability renders legacy order.

### 7.2 Provider option tests

- OpenAI/OpenAI-Codex/Azure keep `promptCacheKey=sessionID`.
- OpenAI retention option is emitted only when capability and config are set.
- Anthropic TTL option is emitted only on Anthropic-compatible routes.
- Diagnostics beta metadata is opt-in.
- DeepSeek still requests usage metadata and uses the late advisory context layout, without unsupported OpenAI-specific options.
- Generic openai-compatible providers still request usage metadata where supported and do not receive unsupported options by default.

### 7.3 Correctness tests

- Memory injection metadata persists on the user message as before.
- Tool visibility/active tool IDs are unchanged by cache layout.
- Permission context remains in the authoritative system prefix.
- Lattice/Blueprint/Cortex contracts remain before messages in first implementation.
- Compaction tests verify governance constraints are not summarized away.

### 7.4 Observability tests

- Region hashes/token estimates are present when diagnostics enabled.
- Raw prompt text, raw memory content, credentials, and secrets are absent.
- Existing cache read/write accounting tests continue to pass.

### 7.5 Live experiment handoff

If live experiments are feasible later:

- Use isolated Windows runtime home and non-conflicting ports.
- Prefer OpenAI-Codex and DeepSeek models configured in the user environment.
- Compare baseline vs optimized prompt-shape stable-prefix estimates first, then provider `cached_tokens` / hit-miss metadata when available.
- Record model, provider, prompt size, turns, cached token deltas, and failures.

## 8. Migration/API/docs impact

### 8.1 Migration

No persisted data migration is required for the initial strategy if:

- message history format remains unchanged,
- prompt regions are computed at runtime,
- provider cache diagnostics are stored only as optional metadata on new assistant parts/messages.

If later implementation adds persisted diagnostics fields, they should be optional and backward-compatible.

### 8.2 API/SDK

No server route or SDK generation is required for the minimal internal implementation.

SDK/OpenAPI work is required only if:

- cache diagnostics become exposed through API routes,
- config schemas become API-visible,
- session stats responses add new public fields beyond existing cache read/write stats.

### 8.3 Config/docs

Docs updates are required if implementation adds user-facing provider config such as:

- OpenAI prompt cache retention,
- Anthropic TTL/diagnostics,
- prompt cache layout mode,
- cache observability flags.

Likely docs to review after implementation:

- `README.md` for provider/cache configuration if user-facing.
- `AGENTS.md` only if agent workflow guidance changes.
- `docs/open-source-quality.md` only if new quality/test commands are added.

### 8.4 Product/UI

No `packages/app/PRODUCT.md` update is needed for the design alone. If later implementation adds a cache diagnostics UI or usage visualization, product docs should be reviewed.

## 9. Risks, tradeoffs, and deferred ideas

### 9.1 Main tradeoff: authority vs cacheability

Moving dynamic context later improves OpenAI-style cacheability but can weaken instruction hierarchy if rendered as user content. Therefore only advisory dynamic context should move in the first implementation. Authority-bearing content stays in stable system regions.

### 9.2 Provider fragmentation

Provider-specific layout increases complexity, but the research shows one layout cannot be optimal for Anthropic explicit cache and OpenAI automatic prefix cache. Mitigation: keep a small internal capability matrix and a legacy fallback.

### 9.3 Cross-turn memory freshness

Memory/experience changes by design across user turns. Moving it later protects history cache but does not make memory itself cacheable. This is acceptable because memory is volatile and correctness/freshness matters more than caching it.

### 9.4 Compaction resets cache

Compaction remains a cache boundary. The initial branch should only make this observable and avoid making it worse. Cache-TTL-aligned compaction belongs to a later branch unless implementation proves cheap.

### 9.5 Retention and privacy

OpenAI extended retention and Anthropic 1h TTL can improve cache hits but may have privacy/cost implications. Defaults should remain provider-default or 5-minute unless user config opts in.

### 9.6 Deferred ideas

- Anthropic cache prewarming.
- Position-independent caching / content-addressable prompt segments.
- Semantic response/tool-result caching.
- Cache-aware scheduler across subagents.
- Cache-TTL-aware compaction.
- UI cache-hit diagnostics dashboard.

## 10. Source/artifact references

Local artifacts:

- `docs/kvcache-baseline-report.md`
- `docs/kvcache-best-practices-research.md`

Key current implementation paths from baseline:

- `packages/synergy/src/session/invoke.ts`
- `packages/synergy/src/session/prompt-budgeter.ts`
- `packages/synergy/src/session/llm.ts`
- `packages/synergy/src/provider/transform.ts`
- `packages/synergy/src/session/recall.ts`
- `packages/synergy/src/session/index.ts`
- `packages/synergy/src/provider/provider.ts`
- `packages/synergy/src/provider/codex.ts`

External sources summarized in research:

- OpenAI Prompt Caching guide: <https://developers.openai.com/api/docs/guides/prompt-caching>
- OpenAI Prompt Caching 201 cookbook: <https://developers.openai.com/cookbook/examples/prompt_caching_201>
- Anthropic Prompt Caching docs: <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- Anthropic Cache Diagnostics docs: <https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics>
- `Don't Break the Cache`, arXiv:2601.06007, <https://arxiv.org/abs/2601.06007>
- `CacheWise`, arXiv:2606.16824, <https://arxiv.org/abs/2606.16824>
- `LMCache`, arXiv:2510.09665, <https://arxiv.org/abs/2510.09665>
- `Governance Decay`, arXiv:2606.22528, <https://arxiv.org/abs/2606.22528>
