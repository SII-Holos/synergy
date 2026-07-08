# Synergy KV-cache baseline report

This report is the read-only baseline artifact for BlueprintLoop `bll_f3ce11ae4001RugP4vpRXx84mT`.

## 1. Worktree confirmation

Command executed from the active worktree:

```text
git rev-parse --show-toplevel && git status --short --branch
```

Output:

```text
C:/Eric/projects/synergy/.synergy/worktrees/synergy-kvcache-optimization-0c3346
## synergy/kvcache-optimization-0c3346
```

Scope stayed inside:

`C:\Eric\projects\synergy\.synergy\worktrees\synergy-kvcache-optimization-0c3346`

No secondary Synergy process was launched for this baseline step.

## 2. Prompt assembly call flow

### 2.1 Loop ownership and loop-local caches

`packages/synergy/src/session/invoke.ts:186-209` starts the session loop, acquires the session runtime, enables `SessionMessageCache`, and registers cleanup. On cleanup it disables `SessionMessageCache`, evicts recall cache, flushes Lattice model-call counts, and releases the session.

Key lines:

- `invoke.ts:198-201` opens `SessionMessageCache.enable(sessionID)`.
- `invoke.ts:202-204` disables the message cache and calls `evictRecallCache(sessionID)`.

This means the message cache and recall cache are loop-scoped, not persistent across user turns.

### 2.2 Memory/experience recall timing

`packages/synergy/src/session/invoke.ts:153-183` defines `recallMemory(...)`:

- `step === 1 && isTopSession`: calls `buildMemoryContext(...)` with a timeout.
- `step > 1 && isTopSession`: returns `getCachedResult(sessionID)`.
- child/non-top sessions get always-only memory context when enabled.

`invoke.ts:169-172` explicitly states the intent: keep recalled memory/experience in the system prompt for every step so the prefix stays stable and cache hits improve inside the trajectory.

### 2.3 System prompt layer ordering

`packages/synergy/src/session/invoke.ts:553-678` builds `systemParts` in stable-to-dynamic order:

1. `customParts` / AGENTS instructions, stable within session: `invoke.ts:557-559`.
2. permission context, semi-static per session: `invoke.ts:561-577`.
3. cortex execution context: `invoke.ts:582-583`.
4. Plan Mode / BlueprintLoop context: `invoke.ts:585-623`.
5. Lattice pathway context: `invoke.ts:625-630`.
6. memory/experience context: `invoke.ts:633-646`.
7. env block: `invoke.ts:648-649`.
8. git health block: `invoke.ts:651-653`.
9. coauthor reminder: `invoke.ts:655-658`.
10. agenda reminder: `invoke.ts:660-661`.
11. cortex reminder/time context: `invoke.ts:663-664`.
12. planning reminder: `invoke.ts:666-668`.
13. elapsed time since last response, only on step 1: `invoke.ts:670-677`.

`systemCacheBreakpoint` is set only for the early stable/semi-stable layers:

- after custom parts: `invoke.ts:557-559`
- after permission context: `invoke.ts:573-577`

It is not moved after cortex, blueprint, lattice, memory, env, git, agenda, planning, or time-context blocks.

### 2.4 PromptBudgeter boundary normalization

`packages/synergy/src/session/prompt-budgeter.ts:74-110` clones and optionally transforms the system prompt in the budget phase, then returns:

- `system: normalizedSystem`
- `systemCacheBreakpoint: normalizeCacheBreakpoint(...)`
- `messages: ProviderTransform.message(input.messages, input.model)`

`normalizeCacheBreakpoint()` at `prompt-budgeter.ts:105-108` drops invalid indices and clamps valid indices to the normalized system length.

### 2.5 Final LLM assembly and provider transform

`packages/synergy/src/session/llm.ts:141-154` builds final `system`:

1. `baseSystem`, from explicit agent prompt or `SystemPrompt.provider(input.model)`, wrapped by `withPreambleSection(...)`.
2. `input.system`, which is `systemParts` from `invoke.ts`.
3. optional `input.user.system`.

`llm.ts:202-205` builds base provider options through `ProviderTransform.options(input.model, input.sessionID, provider.options)` and merges model/agent/variant options.

`llm.ts:295-300` prepends all system messages before model input messages.

`llm.ts:306-314` uses model middleware to call `ProviderTransform.message(...)`, offsetting the cache breakpoint by `baseSystemLength`:

```ts
systemCacheBreakpoint: input.systemCacheBreakpoint === undefined
  ? undefined
  : baseSystemLength + input.systemCacheBreakpoint
```

## 3. Provider cache behavior by route

### 3.1 Anthropic / Claude

`packages/synergy/src/provider/transform.ts:329-337` applies `applyCaching(...)` when:

- `model.providerID === "anthropic"`
- or model API id includes `anthropic`
- or model API id includes `claude`
- or npm SDK is `@ai-sdk/anthropic`

`transform.ts:186-193` selects exactly one system message when `systemCacheBreakpoint` is provided. Otherwise it falls back to legacy selection of the first two system messages and last two non-system messages.

`transform.ts:195-198` injects Anthropic cache control:

```ts
anthropic: {
  cacheControl: {
    type: "ephemeral"
  }
}
```

Current behavior:

- explicit cache breakpoint
- one selected system block under normal path
- ephemeral default TTL only
- no 1h TTL support found
- no Anthropic cache diagnostics support found
- no automatic caching mode found

### 3.2 OpenRouter and Bedrock Anthropic routes

`transform.ts:195-207` defines provider-option variants:

- OpenRouter: `cacheControl: { type: "ephemeral" }`
- Bedrock: `cachePoint: { type: "ephemeral" }`
- OpenAI-compatible: `cache_control: { type: "ephemeral" }`

But these are inside `applyCaching(...)`, which is only called by the Anthropic/Claude condition in `transform.ts:330-337`. Therefore these mappings are not a general cache policy for every OpenRouter/Bedrock/openai-compatible model; they are reached for Anthropic/Claude-style model routes.

`provider/transform.ts:667-701` maps option namespaces:

- `@ai-sdk/amazon-bedrock` -> `{ bedrock: options }`
- `@ai-sdk/anthropic` -> `{ anthropic: options }`
- `@openrouter/ai-sdk-provider` -> `{ openrouter: options }`
- default -> `{ [model.providerID]: options }`

### 3.3 OpenAI / Azure

`packages/synergy/src/provider/transform.ts:581-593` sets:

- `promptCacheKey = sessionID` for provider IDs `openai`, `openai-codex`, or configured `providerOptions.setCacheKey`.
- `store = false` for OpenAI/OpenAI-Codex or SDK `@ai-sdk/openai`.
- Azure sets both `store = false` and `promptCacheKey = sessionID`.

No `prompt_cache_retention` / prompt-cache retention option was found in the inspected code.

### 3.4 OpenAI-Codex

`packages/synergy/src/provider/codex.ts:671-712` extracts `prompt_cache_key` from JSON body and maps it to headers:

- `session_id`
- `x-client-request-id`

It also removes `max_output_tokens` from the body when present. This is a Codex-specific transport bridge for prompt-cache routing.

### 3.5 DeepSeek / openai-compatible

`packages/synergy/src/provider/provider.ts:567-568` enables usage inclusion for `@ai-sdk/openai-compatible` unless disabled:

```ts
options["includeUsage"] = true
```

`packages/synergy/src/session/index.ts:1022-1031` reads DeepSeek/openai-compatible metadata:

- `prompt_cache_hit_tokens`
- `prompt_cache_miss_tokens`

No general prompt layout optimization or cache-control injection was found for DeepSeek/openai-compatible outside Anthropic/Claude route detection.

## 4. Dynamic injection behavior within-turn vs cross-turn

### 4.1 Within one assistant turn / tool loop

Memory/experience is loop-stable after step 1:

- `invoke.ts:159-168`: step 1 builds memory context.
- `invoke.ts:173-175`: later steps use `getCachedResult(sessionID)`.
- `invoke.ts:633-636`: memory result is pushed to `systemParts` and cached on step 1.
- `recall.ts:22-33`: recall cache is a process-local `Map` keyed by session ID.

Other dynamic blocks remain capable of changing inside the same turn because they are rebuilt every prompt assembly:

- env block: `invoke.ts:648-649`
- git health: `invoke.ts:651-653`
- agenda countdown based on `Date.now()`: `invoke.ts:1264-1295`
- planning reminder based on tool accumulation and DAG state: `invoke.ts:1315-1345`

### 4.2 Across consecutive user turns

Across turns, recall cache is evicted on loop exit:

- `invoke.ts:202-204`: `evictRecallCache(sessionID)`.

Next user turn recomputes memory/experience from the latest user text:

- `recall.ts:55-72`: extracts last user text, generates a query embedding, and runs memory/experience retrieval.
- `recall.ts:188-211`: contextual memory search depends on current `userText` and vector similarity.

Elapsed-time context is also turn-specific:

- `invoke.ts:670-677`: inserts `Time since your last response: ...` on step 1.

### 4.3 Cache impact

For Anthropic, explicit cache control is placed at the selected early system block. Dynamic blocks after that selected breakpoint do not poison the selected stable prefix, but they also are not cached by the current explicit breakpoint. Messages after dynamic system content are not covered by the current selected system breakpoint.

For OpenAI/OpenAI-Codex/Azure/openai-compatible automatic prefix caching, dynamic system blocks appear before `messages`. Any change in memory/env/time/git/agenda/planning before historical messages can truncate prefix matching and prevent historical messages from being counted as cached prefix tokens.

## 5. Token accounting and observability

### 5.1 Usage normalization and provider metadata

`packages/synergy/src/session/index.ts:1022-1073` maps cache metadata into normalized token usage:

- hit/read metadata: DeepSeek, openai-compatible, OpenAI `prompt_cache_hit_tokens`
- miss/input metadata: DeepSeek, openai-compatible, OpenAI `prompt_cache_miss_tokens`
- AI SDK `usage.cachedInputTokens`
- write metadata: Anthropic `cacheCreationInputTokens`, Bedrock `usage.cacheWriteInputTokens`

The normalized token object contains:

```ts
cache: {
  ;(write, read)
}
```

Cost calculation includes input, output, cache read, cache write, and reasoning tokens.

### 5.2 Model cost fields

`packages/synergy/src/provider/provider.ts:171-187` maps model catalog cost fields:

- `cache_read` -> `cost.cache.read`
- `cache_write` -> `cost.cache.write`
- over-200k context variants also include cache read/write.

### 5.3 Stored stats fields

`packages/synergy/src/session/message-v2.ts:297-309` stores cache read/write on `StepFinishPart.tokens`.

`packages/synergy/src/session/message-v2.ts:613-620` stores cache read/write on assistant message token info.

`packages/synergy/src/library/turn-digest.ts:90-97` includes cache read/write in turn digest schema, and `turn-digest.ts:204-228` aggregates assistant message tokens into the digest.

`packages/synergy/src/stats/types.ts:8-15` defines `TokenBreakdown.cache.read/write`, and `stats/types.ts:49-52` exposes `cacheHitRate` in token/cost stats.

`packages/synergy/src/stats/aggregator.ts:7-19` initializes and sums cache read/write; `stats/aggregator.ts:66-82` accumulates assistant message tokens by model.

### 5.4 Existing test coverage

Search evidence from `packages/synergy/test` found:

- `test/provider/transform.test.ts`: `ProviderTransform.options - setCacheKey`, OpenAI promptCacheKey, Anthropic cache boundary.
- `test/session/compaction.test.ts`: `Session.getUsage`, cached tokens, DeepSeek/openai-compatible prompt cache metadata, Anthropic cache write metadata.
- `test/session/message-cache.test.ts`: `SessionMessageCache` active window, set/get, updates, invalidation, immutability, and eviction.

## 6. Internal cache inventory

### 6.1 SessionMessageCache

`packages/synergy/src/session/message-cache.ts:4-85` documents the loop-scoped in-memory message cache. It avoids re-reading full session history from disk on every tool-call step. It is an accelerator only; disk remains authoritative. It is enabled at loop start and disabled on loop exit.

`message-cache.ts:41-47` uses a default 256 MB byte budget, configurable by `SYNERGY_SESSION_CACHE_MAX_BYTES`.

`message-cache.ts:175-188` evicts least-recently-used sessions while protecting the session currently being written.

This is local IO/performance caching, not provider KV-cache.

### 6.2 Recall cache

`packages/synergy/src/session/recall.ts:22-33` defines loop-local recall cache helpers:

- `cacheResult`
- `getCachedResult`
- `evictRecallCache`

This improves within-turn prompt stability for memory/experience but is cleared at loop exit.

### 6.3 Token estimation cache

`packages/synergy/src/session/prompt-budgeter.ts:193-210` caches token estimates by model ID and Bun hash of JSON prompt value. It supports prompt budgeting/compaction, not provider KV-cache.

### 6.4 Provider SDK/model cache

`packages/synergy/src/provider/provider.ts:578-583` caches SDK instances for 4 hours.

`provider.ts:814-832` caches language model instances for 4 hours.

These reduce SDK/model object recreation overhead, not prompt KV-cache.

## 7. Current cacheability by provider route

| Provider route                | Current mechanism                                                                        | Cacheable under current layout                                  | Weak/not cacheable under current layout                                             | Main risk                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Anthropic direct / Claude     | Explicit `cacheControl: { type: "ephemeral" }` on selected system block                  | Tools plus system prefix up to selected early stable breakpoint | Cortex/Blueprint/Lattice, memory/experience, env/time/git/agenda/planning, messages | Safe stable-prefix cache, but historical messages are outside current breakpoint |
| Anthropic via OpenRouter      | `openrouter.cacheControl` mapping when Anthropic/Claude condition reaches `applyCaching` | Same intended selected early system prefix                      | Same later dynamic system and messages                                              | Needs provider validation; not a generic OpenRouter policy                       |
| Anthropic via Bedrock         | `bedrock.cachePoint` mapping when Anthropic/Claude condition reaches `applyCaching`      | Same intended selected early system prefix                      | Same later dynamic system and messages                                              | Bedrock-specific cache semantics and accounting need validation                  |
| OpenAI                        | `promptCacheKey=sessionID`, `store=false`                                                | Identical automatic prefix until first changed token            | Any content after changed dynamic system block, especially messages                 | Dynamic system blocks before messages truncate prefix cache                      |
| OpenAI-Codex                  | OpenAI promptCacheKey plus Codex `session_id` / `x-client-request-id` headers            | Same automatic-prefix behavior with Codex routing affinity      | Same as OpenAI                                                                      | Routing key helps locality but does not fix prompt layout                        |
| Azure OpenAI                  | `promptCacheKey=sessionID`, `store=false`                                                | Same as OpenAI                                                  | Same as OpenAI                                                                      | Same dynamic-prefix risk                                                         |
| DeepSeek/openai-compatible    | Usage metadata enabled/read when provider supplies hit/miss tokens                       | Provider-native automatic cache if prefix remains identical     | No Synergy cache-control or prompt layout policy                                    | Dynamic system blocks before messages likely reduce hits                         |
| Generic OpenRouter non-Claude | `usage.include=true`; no explicit cache control found                                    | Provider-dependent                                              | Provider-dependent                                                                  | No current Synergy-specific KV-cache optimization                                |

## 8. Current risks/gaps

1. Cross-turn historical messages are weakly cacheable because volatile system content is before `messages`.
2. OpenAI-style providers only get `promptCacheKey`; prompt layout still causes prefix truncation when memory/env/time changes.
3. Anthropic explicit breakpoint protects stable system prefix but does not cache later dynamic system or message history.
4. Memory/experience is stable within one assistant loop but recomputed across consecutive user turns.
5. Agenda and elapsed-time reminders are explicitly time-dependent and injected before messages.
6. No OpenAI prompt-cache retention option found.
7. No Anthropic 1h TTL or cache diagnostics support found.
8. Existing observability records cache read/write tokens but not prompt-region stability or cache-miss reasons.
9. Existing tests do not prove cross-turn stable-prefix behavior under changing dynamic injections.

## 9. Carry-forward requirements for research/design

1. Design provider-aware prompt layouts instead of one layout for all providers.
2. For OpenAI/OpenAI-compatible providers, move or package volatile context so stable system + historical messages can remain a longer identical prefix where correctness permits.
3. For Anthropic, evaluate multiple breakpoints, TTL policy, and whether later stable history can be cached without including volatile system blocks.
4. Preserve permission/system authority, tool availability semantics, memory injection metadata, compaction behavior, and Lattice/Blueprint correctness.
5. Add deterministic prompt-shape tests for consecutive turns and multi-step tool loops with changing memory/env/time.
6. Extend observability with safe metadata such as cacheable-region token estimates or prefix stability hashes; do not log raw secrets or raw prompt content.
7. Evaluate provider options: OpenAI retention, Anthropic TTL/diagnostics, and conservative behavior for proxies.
