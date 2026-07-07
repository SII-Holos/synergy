# Synergy KV-cache best-practices research

This report is the research artifact for BlueprintLoop `bll_f3ceb2b54001jtkRfxah3oORzB`.

## 1. Inputs and Synergy baseline questions

Primary local input:

- `docs/kvcache-baseline-report.md`

Audited Synergy baseline findings to carry forward:

1. Synergy currently protects an early static system prefix via Anthropic explicit cache control and OpenAI/OpenAI-Codex `promptCacheKey` routing.
2. Cross-turn dynamic system injections before `messages` limit historical-message cacheability, especially for OpenAI/openai-compatible automatic prefix caching.
3. Anthropic explicit breakpoint avoids poisoning the selected early prefix, but current layout does not cache later dynamic system context or conversation history.
4. Existing accounting tracks cache read/write/miss metadata, but observability lacks prompt-region stability, miss reason diagnostics, or cacheable-prefix estimates.

Design questions for this research step:

- How should Synergy order stable instructions, tools, historical messages, and dynamic per-turn context for provider-native cache behavior?
- Which provider-specific options should Synergy expose or set automatically: OpenAI cache key/retention, Anthropic breakpoints/TTL/diagnostics, DeepSeek/openai-compatible usage metadata?
- Which dynamic context must retain system authority and which can move later without changing correctness?
- Which tests and observability signals can prove cacheability without logging raw prompts or secrets?

## 2. Provider findings: OpenAI

Sources:

- OpenAI Prompt Caching guide: <https://developers.openai.com/api/docs/guides/prompt-caching>
- OpenAI Prompt Caching 201 cookbook: <https://developers.openai.com/cookbook/examples/prompt_caching_201>
- OpenAI pricing: <https://developers.openai.com/api/docs/pricing>

Verified provider behavior:

1. **Caching is automatic and exact-prefix based.** OpenAI prompt caching requires the prompt prefix to be identical. It is not semantic matching. The effective prefix includes instructions/messages plus tool definitions, images/audio, and structured output schemas.
2. **Minimum threshold is 1024 prompt tokens.** Prompts below this threshold report zero cached tokens. Above the threshold, cached tokens are reported in cache-granularity increments.
3. **Static content should be first; dynamic content should be last.** OpenAI explicitly recommends placing stable instructions/examples/tool schemas at the beginning and user-specific or request-specific values at the end.
4. **`prompt_cache_key` controls routing affinity, not prefix semantics.** It is combined with the prompt prefix hash to route similar requests to engines more likely to hold the cached prefix. It does not let OpenAI skip over changed dynamic content.
5. **Per prefix+key traffic should avoid hot-shard overflow.** OpenAI documentation and cookbook guidance describe overflow around high request rates for the same prefix/key combination; cache keys need a useful granularity such as session, user, project, or bucket.
6. **`prompt_cache_retention` is a provider option in current docs.** Current OpenAI docs describe in-memory retention and extended retention up to 24 hours for supported models. Synergy baseline did not find any current wiring for this option.
7. **OpenAI cache writes are not separately priced.** Cached input tokens are discounted; write cost is not a separate line item like Anthropic.
8. **Tool/schema stability matters.** Tool definitions, structured output schemas, image detail settings, and ordering become part of the prefix. Changing them breaks reuse.
9. **Use stable full tool lists where possible.** The OpenAI cookbook recommends keeping the `tools` array stable and using request-level tool selection mechanisms, such as allowed-tool subsets where supported, instead of changing the tool schema array.
10. **Observability is token-count based.** OpenAI exposes cached token counts, e.g. `usage.prompt_tokens_details.cached_tokens`; it does not provide an Anthropic-style miss-reason diagnostics API.

Implications for Synergy:

- `promptCacheKey=sessionID` is useful but insufficient if Synergy places volatile memory/env/time blocks before message history.
- OpenAI/openai-compatible layout should maximize one contiguous stable prefix: stable tools/instructions plus historical messages before volatile current-turn context where correctness permits.
- Synergy should evaluate a config/model-capability path for `prompt_cache_retention` on eligible OpenAI models.
- Synergy should add deterministic tests showing dynamic context movement does not alter stable prefix hash/shape across consecutive turns.

## 3. Provider findings: Anthropic

Sources:

- Anthropic Prompt Caching docs: <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- Anthropic Cache Diagnostics docs: <https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics>

Verified provider behavior:

1. **Anthropic supports explicit cache breakpoints.** Developers place `cache_control: { "type": "ephemeral" }` on content blocks. The cached prefix is the content up to that block in the provider's canonical order.
2. **Anthropic also supports automatic caching.** Current docs describe top-level automatic caching that places the breakpoint on the last cacheable block. It consumes one of the available breakpoint slots.
3. **Provider prompt order matters: tools → system → messages.** Cache prefixes are formed in this order. Tool definitions are before system and messages.
4. **Multiple breakpoints are supported.** Current docs describe up to four explicit breakpoints per request. These can represent different stability tiers.
5. **Default TTL is 5 minutes; 1-hour TTL is available.** 5-minute writes cost 1.25× input; 1-hour writes cost 2× input; reads cost 0.1× input. Synergy baseline found only default ephemeral cache control, no TTL selection.
6. **Longer TTL must precede shorter TTL when mixed.** Anthropic requires long-lived cache entries earlier than shorter-lived entries.
7. **Cache writes happen only at breakpoint positions.** Putting a breakpoint on a volatile block is a common mistake because the breakpoint hash changes every request.
8. **Diagnostics exist in beta.** `cache-diagnosis-2026-04-07` can report miss reason types such as `model_changed`, `system_changed`, `tools_changed`, `messages_changed`, `previous_message_not_found`, and `unavailable`, with no raw prompt logging.
9. **`max_tokens: 0` cache pre-warming exists.** Anthropic docs describe pre-warming a cache at a stable explicit breakpoint without generating output, with documented limitations.
10. **Invalidation causes include tool changes, image changes, `tool_choice` changes, message history rewrites, and non-deterministic JSON/tool ordering.**

Implications for Synergy:

- Current Anthropic boundary is safe but underuses Anthropic's multi-breakpoint model.
- Synergy should consider separate Anthropic breakpoints for stable tools/system, run-level context, and possibly stable message history where volatile blocks do not intervene.
- TTL should be configurable or selected by policy: 5-minute for tight tool loops; 1-hour for user-paced conversations or long-running sessions with idle gaps.
- Diagnostics should be available as an opt-in development/debug mode, not always-on production overhead.

## 4. Agent/codebase/literature findings

This section combines accessible external papers plus research-scout findings about agent/codebase practices. Some named agent/codebase sources were not independently URL-verified during this step because generic web search results were noisy; those are marked as unverified where used. The paper/blog sources below are accessible and sufficient for the acceptance criterion.

### 4.1 "Don't Break the Cache" — long-horizon agent prompt caching

Source: "Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks", arXiv:2601.06007, <https://arxiv.org/abs/2601.06007>

Key findings from the abstract/search result:

- Evaluates prompt caching across OpenAI, Anthropic, and Google on 500+ long-horizon agent sessions.
- Reports API cost reductions of 41–80% and TTFT improvements of 13–31% across providers.
- Finds that strategic prompt cache block control, such as placing dynamic content at the end of the system prompt, avoiding dynamic traditional function calling, and excluding dynamic tool results, gives more consistent benefits than naive full-context caching.
- Shows provider-specific differences and confirms prompt size/tool-call count affect benefit after provider minimum thresholds.

Synergy relevance:

- Directly supports moving or isolating dynamic memory/env/tool-result content away from provider-cacheable stable prefixes.
- Reinforces that naively caching the entire growing context can be worse than provider-aware cache block control.

### 4.2 CacheWise — coding-agent KV-cache workloads

Source: "CacheWise: Understanding Workloads and Optimizing KVCache Management for LLM Coding Agents", arXiv:2606.16824, <https://arxiv.org/abs/2606.16824>

Findings reported by the literature subtask:

- Studies real coding-agent KV-cache workloads.
- Uses prefix-aware scheduling and reuse-aware eviction guided by tool-call metadata.
- Reports fewer evictions and better session completion under coding-agent traces.

Synergy relevance:

- Tool-call metadata is already available in Synergy. It can inform cache hints, observability, and later scheduling/eviction policies.
- Even if Synergy cannot control provider KV eviction directly, it can classify prompt regions by stability and expected reuse.

### 4.3 LMCache — production KV-cache layer

Source: "LMCache: An Efficient KV Cache Layer for Enterprise-Scale LLM Inference", arXiv:2510.09665, <https://arxiv.org/abs/2510.09665>

Findings reported by the literature subtask:

- Describes a production KV-cache layer with offloading, cross-engine sharing, prefill/decode disaggregation support, and cache control APIs.
- Emphasizes separating cache management from model-engine details through a connector/control layer.

Synergy relevance:

- Synergy is an API client rather than an inference engine, so it cannot implement GPU KV-cache movement directly.
- The useful abstraction is still applicable: Synergy should expose prompt-region metadata and cache policy decisions separately from provider adapters.

### 4.4 Position-independent / content-addressed caching papers

Sources:

- "Irminsul: MLA-Native Position-Independent Caching for Agentic LLM Serving", arXiv:2605.05696, <https://arxiv.org/abs/2605.05696>
- "MiniPIC: Flexible Position-Independent Caching in <100LOC", arXiv:2606.13126, <https://arxiv.org/abs/2606.13126>

Reported pattern:

- Emerging systems work targets position-independent caching, where identical content can be reused even after shifting positions across turns.
- This is particularly relevant to agent workloads because useful spans often move as new messages are appended or prompt wrappers change.

Synergy relevance:

- Current cloud provider APIs mostly expose exact prefix semantics, not general PIC. Synergy cannot rely on PIC for OpenAI/Anthropic today.
- Synergy can emulate a PIC-friendly architecture at the prompt-assembly layer by making stable regions explicit, hashable, and independently measured. This prepares for future provider or local-engine support.

### 4.5 Context compaction and governance papers

Sources:

- "Self-Compacting Language Model Agents", arXiv:2606.23525, <https://arxiv.org/abs/2606.23525>
- "Slipstream: Trajectory-Grounded Compaction Validation for Long-Horizon Agents", arXiv:2605.08580, <https://arxiv.org/abs/2605.08580>
- "Governance Decay: How Context Compaction Silently Erases Safety Constraints", arXiv:2606.22528, <https://arxiv.org/abs/2606.22528>
- "Contextual Memory Virtualisation: DAG-Based State Management and Structurally Lossless Trimming", arXiv:2602.22402, <https://arxiv.org/abs/2602.22402>

Reported patterns:

- Agent-invoked/self-compaction can reduce cost, but compaction must be timed and validated.
- Lossy summarization can erase safety/governance constraints unless those constraints are pinned outside compaction.
- Structurally lossless trimming removes mechanical bloat like large raw tool outputs or metadata while preserving semantic interaction records.

Synergy relevance:

- Cache optimization and compaction must be co-designed. Compaction rewrites history and therefore resets prefix cache for OpenAI-style providers.
- Permission and governance context must remain pinned in stable system regions and must not be summarized away.
- Tool-output trimming should be structurally lossless before lossy summarization where possible.

### 4.6 Agent/codebase practice reports

The research-scout subtask reported these additional practice patterns:

- OpenCode PR #14743 reportedly split system prompt into stable and dynamic blocks, sorted tool/skill order deterministically, removed repository-specific fields from stable tool schemas, and added cache audit logging. The subtask reports a first-prompt cross-repo hit-rate improvement from 0% to 97.6%, but the URL was not independently verified in this step. Treat the numeric claim as unverified until a design/implementation step confirms the source.
- OpenClaw prompt-caching docs reportedly describe a stable prefix / volatile suffix cache boundary, deterministic MCP tool ordering, cache retention knobs, cache-TTL-aware pruning, and cache trace diagnostics. The URL was not independently verified in this step; use as inspiration, not a verified requirement.
- oh-my-pi compaction notes reportedly describe cache-aware pruning rules such as not replacing tiny tool outputs with placeholders when the placeholder is larger. The URL was not independently verified in this step; use as an example to investigate later.

Synergy relevance of the reported patterns is high even where exact source claims need verification: stable/dynamic splitting, deterministic tool order, and cache audit logging are all independently supported by provider docs and the papers above.

## 5. Cross-source design patterns

1. **Stable prefix first.** Put tools, provider/developer instructions, AGENTS/project instructions, permission/governance context, and schemas before volatile inputs. This is mandatory for OpenAI-style automatic prefix caching and still helpful for Anthropic breakpoint placement.

2. **Volatile context last or explicitly outside cached prefix.** Memory recall, experience snippets, timestamps, git health, agenda countdowns, planning nudges, and current-turn environment should not sit between stable prefix and reusable message history for OpenAI-compatible routes.

3. **Provider-aware layout.** Anthropic can exploit explicit cache breakpoints; OpenAI/openai-compatible providers require one long identical prefix. A single prompt layout will be suboptimal.

4. **Append-only history until a deliberate compaction boundary.** Editing, dropping, reordering, or summarizing earlier messages breaks prefix cache. Compaction should be intentional, observable, and preferably aligned with provider TTL or cache invalidation windows.

5. **Deterministic tools and schemas.** Tool ordering, schema key ordering, MCP/plugin discovery order, image detail settings, and structured-output schemas must remain stable unless a real capability change occurs.

6. **Use selection metadata instead of changing tool definitions.** Where provider APIs support it, keep full stable tool definitions and restrict allowed tools through request metadata rather than changing the `tools` prefix.

7. **TTL and breakpoint tiering.** Anthropic can use multiple breakpoints and TTLs to represent stability tiers: long-lived tools/system, medium-lived run context, short-lived current-turn suffix. OpenAI can use retention options for eligible models.

8. **Cache-aware compaction and trimming.** Prefer structurally lossless trimming of bulky tool outputs before lossy summaries. Pin safety/governance constraints outside compaction.

9. **Observability before tuning.** Track cached tokens, cache write tokens, stable-prefix token estimates, prompt-region hashes, provider miss reasons where available, and before/after cost deltas. Do not log raw prompt content or secrets.

10. **Warmup only when justified.** Anthropic supports pre-warming. Warmup costs and constraints mean it should be opt-in or used for large stable prefixes with expected reuse.

## 6. Synergy-specific requirements

### R1. Prompt-region model

Synergy should represent prompt assembly in explicit regions, at least:

- stable provider/agent instructions
- stable project/AGENTS instructions
- permission/governance context
- provider/tool/schema definitions
- semi-stable run context such as Blueprint/Lattice/Cortex where applicable
- recalled memory/experience
- volatile environment/time/git/agenda/planning context
- historical messages
- current user turn/dynamic suffix

Testability:

- Unit tests should build two consecutive-turn prompt plans with changing memory/env/time and assert which regions remain byte-identical and which are volatile.

### R2. Provider-aware prompt layout

For OpenAI/OpenAI-Codex/Azure/openai-compatible/DeepSeek routes, Synergy should keep the longest safe identical prefix contiguous. Volatile context should not be inserted before historical messages unless it is essential for correctness and cannot be represented later.

For Anthropic routes, Synergy should keep explicit breakpoints at stable boundaries and evaluate multiple breakpoints for different stability tiers.

Testability:

- Provider transform tests should verify OpenAI-style routes preserve stable prefix ordering under changing dynamic context.
- Anthropic tests should verify selected breakpoint positions and TTL metadata without brittle source-text assertions.

### R3. Cache key and retention policy

Synergy should keep `promptCacheKey=sessionID` as a default route-affinity key, but design a future policy option for project/user/session/bucket granularity where traffic patterns justify cross-session reuse.

Synergy should add a provider/model option path for OpenAI `prompt_cache_retention` / SDK equivalent when supported by the model and provider.

Testability:

- Provider option tests should verify the correct options for OpenAI, OpenAI-Codex, Azure, and openai-compatible providers.

### R4. Anthropic TTL, breakpoints, and diagnostics

Synergy should support configurable Anthropic cache TTL policy:

- default 5-minute ephemeral for tight tool loops
- optional 1-hour TTL for user-paced conversations or long-idle sessions

Synergy should support opt-in Anthropic cache diagnostics in development mode, recording miss reason metadata without raw prompts.

Testability:

- Tests should verify TTL ordering constraints and diagnostics option wiring.

### R5. Deterministic tool/schema stability

Synergy should ensure tool definitions and MCP/plugin tool order are deterministic before they enter provider prompt prefix. If Synergy supports request-specific active tool subsets, it should prefer stable full schema plus allowed-tool metadata where provider APIs allow it.

Testability:

- Tests should shuffle tool discovery input and assert stable provider tool ordering/schema output.

### R6. Cache-aware compaction

Synergy compaction should be cache-aware:

- record that compaction resets prefix-cache opportunity for OpenAI-style routes
- avoid compaction during a fresh provider-cache TTL window unless needed for context limits
- prefer structurally lossless trimming before lossy summarization
- pin permission/governance constraints outside compaction

Testability:

- Tests should verify permission/governance context is never summarized into lossy history.
- Compaction tests should verify stable prompt prefix remains unchanged when only dynamic suffix changes.

### R7. Safe observability

Synergy should expose low-noise cache diagnostics:

- provider cached/read/write/miss tokens already tracked
- stable-prefix estimated token count
- cacheable-region hash or fingerprint, never raw prompt content
- provider-specific miss reason where available
- per-turn cost savings estimate where provider metadata allows

Testability:

- Logging/metadata tests should assert no raw prompt or secret text is emitted.

### R8. Measurement harness

The next measurement step should implement deterministic prompt-shape tests before live provider experiments. Live experiments should use isolated `SYNERGY_HOME` and non-conflicting ports on Windows.

Testability:

- A local test harness should generate baseline vs optimized prompt layouts and report stable-prefix token deltas without needing provider API calls.

## 7. Non-goals

1. Do not implement a local GPU KV-cache engine in Synergy. Synergy is currently an API-agent platform, not an inference server.
2. Do not rely on semantic caching for correctness-critical assistant responses in this KV-cache optimization step.
3. Do not log raw prompts, memory contents, secrets, credentials, or user data for cache diagnostics.
4. Do not weaken permission/governance/system authority merely to improve cacheability.
5. Do not add broad provider compatibility shims without model/provider capability checks.
6. Do not force a single prompt layout across Anthropic and OpenAI-style providers if provider semantics differ.
7. Do not treat unverified agent-codebase claims as hard requirements until source URLs or code are inspected.

## 8. Uncertainties and claims requiring verification

1. **AI SDK option names.** OpenAI docs expose `prompt_cache_retention`, but the exact AI SDK field name and provider option namespace must be verified against the installed SDK version before implementation.
2. **OpenAI-compatible provider behavior.** DeepSeek and other compatible providers may expose OpenAI-like metadata but differ in cache key, retention, or routing support.
3. **Anthropic diagnostics beta stability.** Cache diagnostics use a beta header and may change; implementation should be opt-in and tolerant of unavailable metadata.
4. **Multiple system/developer message compatibility.** Some providers or templates reject multiple system messages. Synergy needs provider capability checks before layout divergence.
5. **OpenCode/OpenClaw/oh-my-pi claims.** Research scout reported useful practices, but this step did not independently verify their exact URLs or numeric claims. Treat them as design inspiration pending source/code inspection.
6. **Dynamic context authority.** Moving memory/env/time later in the prompt may alter model behavior. The design step must classify which dynamic context can be late-bound as user/developer context and which must remain system-level.
7. **Warmup economics.** Anthropic `max_tokens: 0` prewarming is documented, but whether it pays off for Synergy depends on stable-prefix size, expected reuse, and user interaction cadence.
8. **Compaction vs cache retention.** Cache-TTL-aligned compaction is plausible but must be reconciled with Synergy's context-limit safety and existing compaction triggers.

## 9. Source list

Provider docs:

- OpenAI Prompt Caching guide: <https://developers.openai.com/api/docs/guides/prompt-caching>
- OpenAI Prompt Caching 201 cookbook: <https://developers.openai.com/cookbook/examples/prompt_caching_201>
- OpenAI pricing: <https://developers.openai.com/api/docs/pricing>
- Anthropic Prompt Caching docs: <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- Anthropic Cache Diagnostics docs: <https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics>

Local Synergy baseline:

- `docs/kvcache-baseline-report.md`

Papers / systems sources:

- "Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks", arXiv:2601.06007, <https://arxiv.org/abs/2601.06007>
- "CacheWise: Understanding Workloads and Optimizing KVCache Management for LLM Coding Agents", arXiv:2606.16824, <https://arxiv.org/abs/2606.16824>
- "LMCache: An Efficient KV Cache Layer for Enterprise-Scale LLM Inference", arXiv:2510.09665, <https://arxiv.org/abs/2510.09665>
- "Irminsul: MLA-Native Position-Independent Caching for Agentic LLM Serving", arXiv:2605.05696, <https://arxiv.org/abs/2605.05696>
- "MiniPIC: Flexible Position-Independent Caching in <100LOC", arXiv:2606.13126, <https://arxiv.org/abs/2606.13126>
- "Self-Compacting Language Model Agents", arXiv:2606.23525, <https://arxiv.org/abs/2606.23525>
- "Slipstream: Trajectory-Grounded Compaction Validation for Long-Horizon Agents", arXiv:2605.08580, <https://arxiv.org/abs/2605.08580>
- "Governance Decay: How Context Compaction Silently Erases Safety Constraints", arXiv:2606.22528, <https://arxiv.org/abs/2606.22528>
- "Contextual Memory Virtualisation: DAG-Based State Management and Structurally Lossless Trimming", arXiv:2602.22402, <https://arxiv.org/abs/2602.22402>

Worktree confirmation:

- Work stayed in `C:\Eric\projects\synergy\.synergy\worktrees\synergy-kvcache-optimization-0c3346`.
- No production code was changed in this research step.
