# Decision Record: Accept Grok xhigh on the pinned xAI SDK

Status: implemented

## Problem

Selecting the `xhigh` reasoning variant for Grok 4.7 failed before the request left the process with `AI_InvalidArgumentError: invalid xai provider options`. The default variant and an explicit `high` variant succeeded. xAI documents `low`, `medium`, `high`, and `xhigh` for `grok-4.6` and later, with `high` as the omitted default.

The catalog correctly advertised `xhigh`. The pinned `@ai-sdk/xai@2.0.42` chat schema accepted only `low` and `high`, and Grok uses that chat factory. Validation therefore rejected a documented effort locally.

## Decision

Pin `@ai-sdk/xai` to `2.0.98`, the latest release on the AI SDK 5 provider line. Its chat and responses schemas accept `low`, `medium`, `high`, and `xhigh`, and the package includes the `grok-4.7` model id. The upgrade stays inside LanguageModelV2 and does not change the Grok provider's chat-completions factory.

A focused regression constructs the chat model for every accepted effort, including `xhigh`, and asserts local schema validation passes. The injected fetch then fails the request, proving the historical `invalid xai provider options` rejection no longer happens before the network boundary.

## Alternatives considered

**Upgrade to `@ai-sdk/xai` 3.x or later.** Rejected: those lines move to LanguageModelV3/V4 and require an AI SDK major upgrade. The current product pins `ai@5.0.212`.

**Stop advertising `xhigh` until the SDK catches up.** Rejected: xAI accepts the value on Grok 4.6 and later. Hiding it preserves a local schema bug and removes a documented control.

**Patch the installed SDK schema in Synergy.** Rejected: the upstream 2.0 line already accepts the value from `2.0.86`. A local patch would fork a dependency that has a compatible release.

## Consequences

Grok `medium` and `xhigh` can pass local provider-option validation. The upgrade also pulls the 2.0.43–2.0.98 chat and responses fixes, including usage, streaming, and error-detail corrections, through xAI's own nested provider packages. Other providers keep their existing pins. The change does not alter variant selection, default effort, or the chat-completions transport.
