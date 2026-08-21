# Decision Record: Route all openai-compatible transports to late-user-context prompt layout

Status: implemented

## Problem

`PromptCachePolicy` routed only OpenAI, OpenAI Codex, Azure, and DeepSeek to the `late-user-context` prompt layout, where volatile advisory context becomes a final `<runtime-context>` user message after the append-only history. Every other provider behind `@ai-sdk/openai-compatible` — built-in profiles (Alibaba Coding Plan, Qwen OAuth, Xiaomi MiMo, SAP AI Core, Cloudflare AI Gateway, ZenMux) and all user-created custom OpenAI-compatible providers (Zhipu GLM via bigmodel.cn/z.ai, Moonshot Kimi, SiliconFlow, and similar gateways) — fell back to the `system` layout, which interleaves volatile late system content between the stable system prompt and history. Because that volatile content changes every turn (memory recall, environment block with date, git health, reminders), providers with automatic prefix caching lost the history-prefix match at the first changed byte and paid full input price for the entire history each turn. Mainstream providers behind that SDK (DeepSeek, Zhipu GLM, Alibaba Qwen, Moonshot) all implement automatic prefix caching without explicit cache-control parameters, and priced cache hits at 10–30% of input cost, so the loss was material.

## Decision

`PromptCachePolicy` now routes every `@ai-sdk/openai-compatible` transport to the `late-user-context` layout by adding that package to `LATE_USER_CONTEXT_SDK_PACKAGES` (`packages/synergy/src/provider/prompt-cache-policy.ts`). The transport-level rule covers both built-in profiles and user-created custom providers in one place, regardless of their provider IDs. DeepSeek remains covered by both its provider ID and the SDK package rule; named account connections still resolve their canonical profile identity first, so proven layouts stay stable when a named account rides a generic SDK transport. The session `promptCacheKey` routing is unchanged: it still applies only to OpenAI, OpenAI Codex, and Azure, since OpenAI-compatible endpoints do not expose an OpenAI `promptCacheKey` equivalent.

## Alternatives considered

**Per-provider ID additions (adding `zai`, `qwen-oauth`, `xiaomi`, … one by one).** Rejected: user-created custom providers have arbitrary IDs, so enumeration cannot cover GLM/Kimi/SiliconFlow configured by users, and every new built-in profile would need a policy edit. The SDK package is the reliable signal of an OpenAI-prefix transport.

**Keeping the `system` layout for unknown OpenAI-compatible providers to stay conservative.** Rejected: the layout choice carries no correctness risk — advisory context remains advisory in both layouts and cannot override higher-priority instructions — while the `system` layout demonstrably destroyed prefix-cache reuse for every provider that does implement automatic caching. A provider without prefix caching loses only the stricter ordering, never correctness.

**Mapping Synergy session IDs to DeepSeek-style `user_id` parameters for cache affinity.** Rejected and documented in code: DeepSeek documents `user_id` as privacy/KVCache isolation, not as an affinity key; it would split the cache space rather than improve hit rates.

## Consequences

All OpenAI-compatible providers — built-in and user-created — now keep stable system content and tool-call history as a byte-stable prefix, with volatile advisory context moved after it, matching how DeepSeek, GLM, Qwen, Kimi, and OpenAI-compatible gateways implement automatic prefix caching. Providers behind the SDK that genuinely lack prefix caching see only a weaker system-message ordering. Prompt shape for these providers changed visibly (advisory content now arrives as the final user message wrapped in `<runtime-context>` with its non-override disclaimer), which providers may surface in debugging or prompt-shape tooling. Verified by `packages/synergy/test/provider/prompt-cache-policy.test.ts` and the existing kvcache-measurement, transform, invoke, compaction, and provider test suites.
