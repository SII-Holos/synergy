# Decision Record: Explicit Responses factories for Grok and Codex

Status: implemented

## Problem

The Grok builtin profile selects the Chat Completions factory, but the installed `@ai-sdk/xai@5.0.24` exposes `responses()` and no `chat()`. Model construction therefore fails before inference. A regression that constructs `languageModel()` directly can pass while the builtin profile still calls a missing factory. The earlier [Grok reasoning-effort fix](2026-09-29-xai-xhigh-reasoning-effort.md) established accepted effort values, not compatibility between this SDK release and the selected profile factory.

Codex already uses `apiMode: "codex_responses"` and the `@ai-sdk/openai` Responses factory. It needs preservation coverage alongside the Grok repair, not a migration from Chat Completions. Sharing a Responses protocol does not make the two providers' authentication or provider options interchangeable.

## Decision

Keep `@ai-sdk/xai` on version 5 and select `apiMode: "responses"` with an explicit `responses()` factory for the Grok builtin profile. Keep Codex on `codex_responses` with `@ai-sdk/openai.responses()`. Treat protocol selection and factory selection as a pair; do not silently substitute `languageModel()` when an explicitly selected factory is absent. The [LLM loop](../../../architecture/llm-loop.md#builtin-responses-providers) owns the current provider protocol description.

Both providers retain subscription OAuth and their provider-specific request preparation. Codex retains its existing opaque compaction artifacts and identity-gated encrypted reasoning replay; this repair does not change compaction. The [reasoning replay decision](2026-09-23-replay-only-encrypted-codex-reasoning.md) continues to own those replay conditions.

Compatibility verification must construct models through the actual builtin profile and installed SDK factory, then inspect the physical Responses request. Direct SDK construction alone cannot establish that the shipped profile works. Protocol regressions must cover request routing, reasoning options and tool continuation for each provider without treating one provider's options as the other's.

Grok's main and auxiliary requests default to `store: false` through the existing provider transforms; explicit model options retain their ordinary precedence. The installed SDK's [Responses options](https://ai-sdk.dev/providers/ai-sdk-providers/xai) otherwise enable remote storage. The physical request regressions assert this setting alongside reasoning efforts and tool continuation.

[Prompt budgeting](../../../../packages/harness/src/session/prompt-budgeter.ts) treats OpenAI and xAI encrypted reasoning as opaque payloads. Replay estimates use provider-qualified item identity and producer-reported usage, preserving the existing conservative floor for absent or invalid usage. Storage round trips and same-ID cross-provider tests protect retained metadata and prevent one provider's reasoning allowance from being reused for another.

## Alternatives considered

**Roll back to an older xAI SDK with a chat factory.** Rejected because it restores a retired factory dependency instead of aligning the builtin profile with the installed SDK and runtime interface. It also gives up the version-5 implementation and fixes merely to keep the old transport selection.

**Silently fall back to `languageModel()`.** Rejected because its SDK-defined default hides a mismatch between declared `apiMode`, selected factory and emitted protocol. It also lets a profile-selection regression escape a direct-construction test again.

**Select Responses explicitly.** Chosen because the installed xAI SDK exposes that factory, and the protocol can be asserted at the actual request. Codex supplies an existing Responses path whose provider-specific behavior must remain intact, not a reason to replace either provider's SDK or OAuth flow.

## Consequences

The Grok fix changes its declared inference protocol rather than downgrading its SDK or adding an implicit fallback. Codex keeps its native Responses behavior. Tests must exercise both the real profile/factory path and emitted requests; an option-schema check, compilation or a fabricated stream alone cannot prove account compatibility.

Real-account acceptance remains separate from local protocol fixtures and static checks. It exercises streamed text, reasoning selection, a tool-result round trip and subsequent history replay through the production request path; verification reports actual account results without publishing credentials or private inference artifacts.
