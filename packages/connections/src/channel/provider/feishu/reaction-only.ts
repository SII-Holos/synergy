import z from "zod"

/**
 * Reaction-only terminal delivery: the Feishu reaction vocabulary and the
 * `reactionOnlyReply` account-config resolution shared by the model-facing
 * tool schema, the account config schema, the availability gate, and the
 * Channel runtime.
 *
 * Feishu `emoji_type` values are case-sensitive strings rejected by the
 * Message Reaction API with `231001` when unknown, so one curated allowlist
 * backs both the tool parameter schema and `forceReaction` validation.
 * Values are taken from the official emoji copy table:
 * https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
 *
 * This module stays dependency-free (zod only) so `config-schema.ts` can
 * import the vocabulary without creating a provider/config cycle.
 */
export const FEISHU_REACTION_EMOJI_VALUES = [
  "SILENT",
  "SHHH",
  "EYESCLOSED",
  "DONE",
  "OK",
  "THUMBSUP",
  "JIAYI",
  "CheckMark",
  "OnIt",
  "Get",
  "LGTM",
  "OneSecond",
  "SALUTE",
  "SMILE",
  "THANKS",
  "FINGERHEART",
  "HEART",
  "CLAP",
  "PRAISE",
  "THINKING",
  "SLEEP",
  "Sigh",
  "FACEPALM",
  "SPEECHLESS",
  "WHAT",
] as const

export const FeishuReactionEmoji = z.enum(FEISHU_REACTION_EMOJI_VALUES)

export type FeishuReactionEmoji = z.infer<typeof FeishuReactionEmoji>

/** Default reaction when a reaction-only turn does not name one. */
export const DEFAULT_FEISHU_REACTION_ONLY_EMOJI: FeishuReactionEmoji = "SILENT"

/**
 * Emoji types the provider itself sets for task progress; they are real Feishu
 * emoji types but are not offered to the model, so they stay out of
 * `FEISHU_REACTION_EMOJI_VALUES` while still passing reaction validation.
 */
export const FEISHU_STATUS_REACTION_EMOJIS = ["Typing", "ERROR"] as const

/**
 * Whether `value` is an `emoji_type` the provider is willing to send. Kept
 * deliberately curated rather than exhaustive: Feishu rejects unknown types
 * with `231001`, and this rejects them locally with the same code before
 * spending a round trip. Extend it whenever the product starts sending a new
 * Feishu emoji type.
 */
export function isKnownFeishuReactionEmoji(value: string): boolean {
  return (
    FeishuReactionEmoji.safeParse(value.trim()).success ||
    (FEISHU_STATUS_REACTION_EMOJIS as readonly string[]).includes(value.trim())
  )
}

/** Feishu's own business code for an invalid reaction type. */
export const FEISHU_REACTION_TYPE_INVALID_CODE = 231001

/** Carries Feishu's authoritative business rejection separately from an uncertain transport outcome. */
export class FeishuReactionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | undefined,
  ) {
    super(message)
    this.name = "FeishuReactionError"
  }
}

/** Trim without case folding: Feishu emoji types are case-sensitive. */
export function normalizeFeishuReactionEmoji(value: string | undefined): FeishuReactionEmoji | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const parsed = FeishuReactionEmoji.safeParse(trimmed)
  return parsed.success ? parsed.data : undefined
}

/**
 * Account and channel config are typed `unknown` because callers hold the
 * whole channel config union (feishu | clarus | github), which is not
 * assignable to a weak all-optional parameter type. Narrowing happens here,
 * the same way `resolveChannelAccountInvocation` and
 * `resolveChannelAccountAgent` read account config.
 */
function readStreaming(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") return undefined
  const streaming = (value as { streaming?: unknown }).streaming
  return typeof streaming === "boolean" ? streaming : undefined
}

function readReactionOnly(value: unknown): { enabled?: boolean; forceReaction?: string } {
  if (!value || typeof value !== "object") return {}
  const settings = (value as { reactionOnlyReply?: unknown }).reactionOnlyReply
  if (!settings || typeof settings !== "object") return {}
  const enabled = (settings as { enabled?: unknown }).enabled
  const forceReaction = (settings as { forceReaction?: unknown }).forceReaction
  return {
    ...(typeof enabled === "boolean" ? { enabled } : {}),
    ...(typeof forceReaction === "string" ? { forceReaction } : {}),
  }
}

/**
 * Resolve the effective `reactionOnlyReply` setting. Absent config, absent
 * `enabled`, or an unparsable `forceReaction` all resolve to disabled so an
 * unconfigured or mistyped account keeps its existing delivery behavior. The
 * reaction is forced: the model never names one, the config is the reply.
 */
export function resolveFeishuReactionOnlyReply(input: { account: unknown; channel: unknown }): {
  enabled: boolean
  forceReaction: FeishuReactionEmoji
} {
  const fallback = {
    enabled: false,
    forceReaction: DEFAULT_FEISHU_REACTION_ONLY_EMOJI,
  }
  const settings = readReactionOnly(input.account)
  if (settings.enabled !== true) return fallback
  return {
    enabled: true,
    forceReaction: normalizeFeishuReactionEmoji(settings.forceReaction) ?? DEFAULT_FEISHU_REACTION_ONLY_EMOJI,
  }
}

/**
 * Resolve the effective streaming setting for a Feishu account. Single source
 * of truth for the account-over-channel-over-default order, used by both the
 * provider's streaming session factory and the reaction-only availability
 * gate (which reads raw config rather than provider account state).
 */
export function resolveFeishuStreaming(input: { account: unknown; channel: unknown }): boolean {
  return readStreaming(input.account) ?? readStreaming(input.channel) ?? true
}

/**
 * Whether a reaction-only terminal turn is available for this account. The
 * streaming card is created before the model runs and Feishu exposes no
 * retraction here, so a reaction-only turn that must post no message at all is
 * only correct on non-streaming accounts.
 */
export function isFeishuReactionOnlyAvailable(input: { account: unknown; channel: unknown }): boolean {
  if (!resolveFeishuReactionOnlyReply(input).enabled) return false
  return !resolveFeishuStreaming(input)
}
