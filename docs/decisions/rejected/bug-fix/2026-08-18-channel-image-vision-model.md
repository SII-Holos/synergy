# Decision Record: Route channel image messages to the vision model

Status: rejected — channel model selection aligns with chat: override always wins, unsupported images degrade to text with the look_at tool fallback

## Problem

Feishu channel messages with image attachments materialize the attachment correctly (download → temp file → data URL → `file` model part), but the channel session's invocation model was always the pinned/account model. When that model does not support image input (e.g. the default `deepseek-v4-flash` text model), `ProviderTransform.unsupportedParts` degrades the image part to a text placeholder at the provider boundary — the model only sees `[Image]` and a "does not support image input" notice, and the image never actually reaches the model.

## Proposal

`Channel.handleMessage` detects image attachments (`ctx.attachments` with `contentType` starting `image/`) and, when the resolved invocation model lacks image input capability, switches the delivery to the configured `vision_model` role. The switch happens only when (1) the message carries at least one image attachment, (2) the pinned model is known to lack image capability (`capabilities.input.image === false`), and (3) a distinct `vision_model` is configured and available.

## Alternatives considered

- **Align with chat: override always wins, degradation text + look_at tools (chosen)** — chat never switches models based on message content. The composer's explicit per-message model and the session `modelOverride` always win (`input.model ?? session?.modelOverride ?? Agent.getAvailableModel(agent) ?? lastModel` in `createUserMessage`), and when the model cannot consume images, `unsupportedParts` degrades the part to text while the `look_at` tool is exposed as the model-driven fallback. Channel accounts already share the same precedence via `resolveChannelAccountInvocation`, so the correct behavior is to keep it, not replace it.
- **Auto-switch to vision_model (this proposal)** — rejected: it would override a user's explicit model override whenever the pinned model lacks image capability, breaking the "explicit selection always wins" invariant that chat maintains. Channel has no per-message model picker, but that is a UX gap to address separately, not a reason to silently replace the user's chosen model.
- **Inject a look_at hint into the prompt instead of switching** — the existing `unsupportedParts` degradation already carries look_at guidance; no additional injection is needed once switching is rejected.

## Acceptance criteria

- A channel message with an image attachment invokes the pinned/account model (or session `modelOverride`) unchanged.
- A non-vision pinned model receiving an image keeps the existing degradation text and look_at guidance.
- No per-message model switching is introduced in the channel delivery seam.

## Risks

- Without a vision-capable pinned model, channel image messages never reach the model directly; the model must use `look_at` to analyze them. This matches chat behavior and is the accepted trade-off.
