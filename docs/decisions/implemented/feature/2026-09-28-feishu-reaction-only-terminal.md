# Decision Record: Feishu Channel reaction-only terminal delivery

Status: implemented

## Problem

Feishu Channel already supported adding status reactions (`Typing`, `DONE`, `ERROR`) to the inbound message as task progress feedback, but it had no way to express "this message is handled, and a reaction is the whole answer". Every completed turn still delivered some message — text, a Markdown card, an attachment, or a pushed reply — so the model could not choose to acknowledge without producing new chat content. Adding that capability required a typed, per-turn terminal choice that stays exclusive (never delivered alongside anything else), leaves existing behavior byte-for-byte unchanged when not chosen, never degrades to a text reply on failure, and stays invisible to other channels.

## Decision

The capability is delivered as a structured terminal intent on the generic Channel contract plus a first-party, Feishu-gated tool.

- **Contract.** `packages/connections/src/channel/types.ts` adds `ChannelTerminalIntent`: a discriminated union with one member `{ type: "reaction_only", reaction }` (required, 1–64 chars, `.strict()`).

- **Model action.** A new first-party tool `channel_reaction_only` (`packages/connections/src/channel/tools/channel-reaction-only.ts`) is the only way to trigger the capability. It records the chosen reaction as `metadata.intent` on the completed tool part — the same machine-consumed pattern as `ResponseCardIntent` — and returns no provider side effect itself. The Channel runtime owns delivery.

- **Config.** `ChannelFeishuAccount` gains `reactionOnlyReply: { "enabled": false default, "forceReaction": <Feishu emoji_type> }` (`packages/connections/src/config-schema.ts`), validated against a curated `emoji_type` allowlist in `packages/connections/src/channel/provider/feishu/reaction-only.ts`. The reaction is forced — the model takes no reaction parameter — and falls back to `SILENT` when unset.

- **Visibility gate.** `packages/connections/src/channel/tool-policy.ts` hides the tool structurally (the tool is removed from the visible set, not merely discouraged). The channel-level rule is synchronous (`visibility`); the account-config rule runs in the awaited `availability` hook. The gate is fail-closed.

- **Availability constraint.** The capability is offered only when `reactionOnlyReply.enabled === true` and the account resolves to `streaming: false`. The shared resolver `resolveFeishuStreaming` (account over channel over `true`) backs both the provider session factory and the gate.

- **Boss-role exclusion.** The gate also hides the tool from boss-role sessions (`workflow.kind === "boss" && role === "boss"`). Boss sessions deliver only through explicit `channel_push` (R6): the foreground path skips reaction delivery for boss routes and the outbound bridge skips boss sessions outright, so a reaction-only terminal would swallow the turn — no reaction, no content, no follow-up model round.

- **Loop-job turn closure.** A blocking post loop job (`packages/connections/src/channel/loop-jobs.ts`) rewrites the intent-bearing assistant's `finish` to `stop` so the turn closes without burning another LLM round. Its collect step waits while any sibling tool call on the same assistant is still in flight (any non-`completed`/`error` status); once the sibling settles, the job fires again and closes the turn.

- **Exclusive delivery.** When an intent is present, the turn posts nothing else on either delivery path. In the foreground terminal path (`packages/connections/src/channel/index.ts`) it closes the streaming session with no text and ends the status-reaction flow with `setFinishedWith(reaction)` — a single intentional reaction rather than `setDone()` plus a second reaction — then records the outcome. In the outbound bridge (`packages/connections/src/channel/reaction-only-runtime.ts` consumed by `outbound.ts`) the intent is read from the persisted tool part; a resolved turn (delivered or failed) never falls through to normal delivery.

- **Target and idempotency.** The reaction is applied to the user's own inbound message, not the reply anchor, which in a threaded scope is the topic root; the inbound id is persisted as `channelInboundMessageId` on the root user message and resolved by the bridge with the anchor as fallback. Success is recorded as `channelReactionOnlyDelivered` plus `channelOutboundSent`; failure as `channelReactionOnlyError` — never marked delivered and never converted to text. Those durable markers are the idempotency guard, because Feishu creates a new reaction on every call and exposes no "already reacted" error.

- **Provider.** `addReaction`/`removeReaction` in `packages/connections/src/channel/provider/feishu/index.ts` reject blank or unknown `emoji_type` locally with Feishu's own code `231001` and surface `FeishuReactionError` carrying HTTP status and business code. `readFeishuReactionResult` enforces Feishu's `ok ⇔ code 0` contract: a non-OK status carrying `code: 0` is a protocol contradiction and is reported as a transport failure, never as a delivered reaction. Status reactions use `Typing`/`ERROR`, which are valid Feishu types deliberately kept out of the model-facing allowlist.

## Alternatives considered

**Infer reaction-only from a trailing emoji in the reply text** was rejected: it is not a typed, machine-consumed signal, would misfire when ordinary prose ends in an emoji, and cannot guarantee exclusivity.

**Adapt the existing status-reaction controller alone** was rejected: that flow is unconditional progress feedback (`setDone` always fires), would stack two reactions on the message, and cannot express "finish with this exact emoji instead of `DONE`". The controller gained `setFinishedWith(emoji)` precisely so a reaction-only turn ends with one intentional reaction.

**Support streaming accounts by retracting the card afterward** was rejected for now: the Feishu streaming card is created synchronously before the model runs (`index.ts` calls `streaming.start()` before invoke) and this provider has no retraction capability. Introducing a new provider boundary just to enable the feature was out of scope, so availability is scoped to non-streaming accounts; streaming support is a separate future decision.

**Deliver reaction-only only on the foreground path** was rejected: the outbound bridge also observes recovered or queued turns. Reading the intent from the persisted tool part in both paths, with durable markers, prevents a recovered or redelivered turn from both re-reacting and posting a duplicate message.

## Consequences

Feishu/Lark accounts can now opt into a per-turn "acknowledge without a message" channel capability; the model chooses per message between a normal reply and a reaction, while accounts that do not opt in and all other channels (Clarus, GitHub, Boss Mode, streaming cards, response cards, question cards) are unchanged. The capability is removed from the model's tool list unless the account enables it and is non-streaming, so there is no migration and no visible change for existing configurations. Failures are surfaced as durable error state with logs instead of being silently converted into text, and retries stay idempotent through the recorded markers. The trade-off is a small, curated `emoji_type` vocabulary that must be extended when Feishu introduces a new reaction type the product wants to offer.
