# Decision Record: Anthropic late-user-context layout with a history-tail cache breakpoint

Status: implemented

## Problem

Anthropic has no automatic prefix caching: only content covered by an explicit `cache_control` breakpoint is cached, at 0.1× the input price for reads. In the production layout — where `systemCacheBreakpoint` is set whenever project instructions or permission context exist, i.e. nearly always — `applyCaching` marked only the stable system block. The entire conversation history, including the tool-loop transcript that dominates agent token consumption, was re-billed at full input price on every step with full first-token latency. The fallback branch (no breakpoint) did mark the last two messages, but it is unreachable in practice. Adding a history breakpoint alone would not have fixed this: Anthropic used the `system` layout, where volatile late system blocks (memory recall, environment block, reminders — different every turn) sit between the stable system and history, so a cache entry ending inside history could never match a later request and its 1.25× write cost would be pure waste.

## Decision

Anthropic now uses the late-user-context layout, joining OpenAI, OpenAI Codex, DeepSeek, Azure, and every `@ai-sdk/openai-compatible` transport: volatile advisory context moves after the append-only history as a final `<runtime-context>` user message (`PromptCachePolicy`, `packages/synergy/src/provider/prompt-cache-policy.ts`). On that layout, `applyCaching` in `packages/synergy/src/provider/transform.ts` marks a second breakpoint on the last history message — the message before the `<runtime-context>` user message when one is present, otherwise the final message — so `stable system ✂ history ✂` is cached and reused incrementally across tool-loop steps and turns. The `<runtime-context>` message itself never receives a breakpoint: it changes every turn, so a breakpoint ending inside it would never be hit again. The `system` layout (Bedrock, Vertex-Claude, and other unproven providers) intentionally receives no history breakpoint, because its volatile late system blocks sit before history and would strand any history cache entry. Consecutive user messages (tool results followed by the runtime-context user message) are valid on the current Anthropic Messages API, so no message merging is needed.

## Alternatives considered

**Only add the history-tail breakpoint, keeping the `system` layout.** Rejected: with volatile late system blocks before history, a history breakpoint's cache entry is dead on arrival — each turn diverges before history starts, so the 1.25× cache-write cost buys nothing. The layout change is the prerequisite that makes the breakpoint profitable.

**Mark breakpoints on the last two messages (restore the legacy fallback selection) in addition to the system breakpoint.** Rejected: the final `<runtime-context>` user message is always volatile, so a breakpoint on it is never reused. Marking the last history message only (skipping the runtime-context message) achieves the same incremental caching with one fewer write.

**Treat Bedrock and Vertex-Claude the same as native Anthropic.** Rejected: Bedrock's prompt caching has its own granularity and pricing tiers, and Vertex Anthropic's caching semantics are governed by Vertex. Keeping them on the `system` layout is the conservative choice until each is verified against its own platform's cache contract; the layout policy extension point remains per-provider.

## Consequences

Anthropic sessions now cache the stable system prompt and the full history prefix: within a tool loop each step pays full price only for newly added transcript plus the runtime-context message, instead of the whole history. The prompt shape changed visibly for Anthropic: advisory context now arrives as the final user message rather than mid-prompt system blocks (wrapped in `<runtime-context>` with its non-override disclaimer), and each request carries two `cache_control` breakpoints (three only during the rare no-breakpoint fallback). Anthropic cache-write costs (1.25× input for the newly cached tail) now appear in usage, where previously they were zero because nothing but the system block was cached. Bedrock and Vertex-Claude behavior is unchanged. Verified by `packages/synergy/test/provider/transform.test.ts`, `packages/synergy/test/provider/prompt-cache-policy.test.ts`, and `packages/synergy/test/session/kvcache-measurement.test.ts`.
