# Decision Record: Opt-in mergeSystemMessages provider option for strict single-system endpoints

Status: implemented

## Problem

Synergy assembles layered system context as multiple leading `system` messages (agent prompt, project instructions, permission context, workflow context) in the message array, on purpose so the provider transform can place per-block cache breakpoints. Strict OpenAI-compatible endpoints built on vLLM with recent Qwen chat templates validate that exactly zero or one `system` message exists and that it sits at index 0, rejecting anything else with `400 System message must be at the beginning.` (QwenLM issue 144 confirms the error text is misleading — the real constraint is "exactly one", not "must be first"; vLLM issue 41114 tracks the template behavior). Custom user-created providers targeting such endpoints (for example a Qwen3.8-27B vLLM deployment) therefore fail on every main-loop request whenever more than one system part is present — which is the production norm whenever project instructions or permission context exist. Compaction paths happened to stay compatible only by luck (their single trimming marker is the sole leading system message).

## Decision

Add a per-provider `options.mergeSystemMessages` boolean (default `false`) to the provider config schema (`packages/synergy/src/config/schema.ts`), surfaced through `ProviderTransform.message()` in `packages/synergy/src/provider/transform.ts`. When enabled — and only when enabled — the transform collapses the leading run of `system` messages into one `system` message, joining their text contents with blank lines in original order; array-content system messages merge only their text parts, and any message in the run without textual content aborts the merge (safer to fail the request than to silently drop content). The option rides the same wire as `setCacheKey`: provider `options` → `Provider.workerPlan` → `LLM.stream` middleware → `MessageOptions.mergeSystemMessages`. The generated JSON schema (`packages/synergy/schema/config.schema.json`) and the synergy-config skill provider reference document the field, the triggering error text, the vLLM/Qwen applicability, and the cache trade-off.

Naming follows reviewed ecosystem practice: pydantic-ai ships the exact inverse (`openai_chat_supports_multiple_system_messages`, default true, whose false branch runs `_merge_leading_system_messages` and whose docs quote the same vLLM/Qwen error); pi (earendil-works) keeps capability-declaration compat keys per provider with model-level override; opencode has no such option and its community hits the same 400 with only plugin-level workarounds.

## Alternatives considered

**Enable merging automatically for models whose ID contains "qwen" (heuristic, like the Mistral toolCallId normalization).** Rejected as the default: permissive Qwen endpoints (DashScope, OpenAI-compatible gateways) accept multiple system messages, so a heuristic would rewrite prompts for endpoints that do not need it, and the strict-template population is exactly "custom user-deployed vLLM endpoints" — users who can see and flip one documented option. The explicit opt-in keeps wire format unchanged for every existing provider.

**Merge in `LLM.promptMessages` instead of the provider transform.** Rejected: the transform layer is where per-provider wire-format constraints already live (Mistral sequence repair, Anthropic tool_use splitting, Bedrock image limits), it runs after plugin `chat.system.transform` hooks have finalized the system array, and it keeps the layout function layout-only.

**Demote extra system messages to user messages wrapped in `<system>` tags (pydantic-ai `supports_inline_system_prompts` style).** Rejected for now: heavier semantic change (system-role authority is lost for the demoted parts), and the single-merge form already satisfies the strict endpoints observed.

**Fix the endpoint side (Qwen-Fixed-Chat-Templates / chat template patch).** Out of scope: endpoint operators can adopt fixed templates, but Synergy must work against deployments its users cannot patch.

## Consequences

Providers that enable `mergeSystemMessages` become usable on strict single-system endpoints: the request shape becomes `[merged system, history...]`, satisfying the index-0/exactly-one validation. When a merge actually collapses the leading system run, the transform clamps `systemCacheBreakpoint` to 0 so Anthropic-style transports keep a breakpoint on the (now single) merged system block instead of silently indexing past it and dropping the system breakpoint entirely; the merged system text remains byte-stable across turns, so automatic prefix caching still hits. The merge coarsens the per-block granularity of the system-region breakpoint (one breakpoint over the whole merged block instead of a boundary between stable layers), which is the documented trade-off for strict-endpoint compatibility; providers that do not enable the option see zero change. Verified by `packages/synergy/test/provider/transform.test.ts` (merge enabled, default-off passthrough, breakpoint clamping) and the wider provider/session suites; `bun script/generate-schema.ts` + prettier regenerate the published JSON schema.
