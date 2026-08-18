# Decision Record: Route channel image messages to the vision model

Status: implemented

## Problem

Feishu channel messages with image attachments materialized the attachment correctly (download → temp file → data URL → `file` model part), but the channel session's pinned model was used as-is for the invocation. When that model does not support image input (e.g. the default `deepseek-v4-flash` text model), `ProviderTransform.unsupportedParts` degrades the image part to a text placeholder at the provider boundary, so the model only ever sees `[Image]` and a "this model does not support image input" notice. The configured `vision_model` was never consulted for channel messages, unlike the chat/session path where images are streamed straight into a capable model (or `look_at` is offered).

## Decision

`Channel.handleMessage` now detects image attachments on the inbound message (`ctx.attachments` with `contentType` starting `image/`) and, when the resolved invocation model lacks image input capability, resolves the configured `vision_model` role and uses it for the delivery. The switch happens only when all of the following hold:

- the message carries at least one image attachment,
- the pinned model is known to lack image input capability (`capabilities.input.image === false`),
- a distinct `vision_model` is configured and the model is available.

Otherwise the pinned invocation is returned unchanged. The variant is dropped when switching (the vision model may not support the account variant), and the session's explicit `modelOverride` still wins via `resolveChannelAccountInvocation`.

## Alternatives considered

- **Always switch to vision_model when any image is present** — rejected: would override a user's explicit model override even when the pinned model already supports images.
- **Inject a look_at hint instead of switching** — rejected: chat parity is the goal; the image should reach the model directly when a vision model exists, with the existing `unsupportedParts` degradation (including the look_at guidance) remaining as the fallback when no vision model is configured.

## Consequences

Feishu (and any channel) image messages now reach a vision-capable model when one is configured, matching chat behavior. When no vision model is configured, behavior is unchanged (degradation text with look_at guidance). The switch is per-message (the message's invocation model), not persisted on the session, so subsequent text-only messages keep the account/default model.
