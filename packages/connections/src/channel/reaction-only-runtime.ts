import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { ChannelTerminalIntent } from "./types"
import type { Provider } from "./types"
import { FeishuReactionError } from "./provider/feishu/reaction-only"

const log = Log.create({ service: "channel.reaction-only" })

/** Tool whose completed part carries a reaction-only terminal intent. */
const REACTION_ONLY_TOOL = "channel_reaction_only"

/**
 * Terminal assistant metadata recording that this turn's reaction-only
 * delivery succeeded, holding the emoji that was applied. Together with the
 * pre-dispatch attempt it prevents a duplicate after recovery; Feishu creates
 * a new reaction per call and exposes no idempotency key.
 */
export const CHANNEL_REACTION_ONLY_DELIVERED = "channelReactionOnlyDelivered"

/**
 * Terminal assistant metadata recording a failed reaction-only delivery. It
 * doubles as the retry guard: merging it re-publishes the terminal, which
 * would re-enter the outbound bridge. Marking the attempt stops that loop
 * while leaving the failure visible and never marking the turn delivered.
 */
export const CHANNEL_REACTION_ONLY_ERROR = "channelReactionOnlyError"

/** Durable pre-dispatch guard, retained when the provider outcome is uncertain. */
export const CHANNEL_REACTION_ONLY_ATTEMPTED = "channelReactionOnlyAttempted"

export type ReactionOnlyIntent = { reaction: string; partID: string }

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

/**
 * Resolve the message a reaction-only turn must react to: the message the user
 * actually sent, not the reply anchor. A threaded Feishu reply anchors to the
 * topic root, so reacting to the anchor would mark the wrong message. The
 * inbound id is persisted on the root user message; `replyToMessageId` is the
 * fallback for turns recorded before it was tracked.
 */
export function resolveReactionTarget(
  messages: MessageV2.WithParts[],
  rootID: string,
  replyToMessageId: string | undefined,
): string | undefined {
  const root = messages.find(
    (message) => message.info.role === "user" && (message.info.id === rootID || message.info.rootID === rootID),
  )
  return (
    metadataString(root?.info.metadata as Record<string, unknown> | undefined, "channelInboundMessageId") ??
    replyToMessageId
  )
}

/**
 * Whether this assistant's reaction was attempted or resolved. Every such
 * outcome stops automatic re-delivery without converting the intent to text.
 */
export function reactionOnlyResolved(assistant: MessageV2.Assistant): boolean {
  const metadata = assistant.metadata as Record<string, unknown> | undefined
  return (
    !!metadataString(metadata, CHANNEL_REACTION_ONLY_DELIVERED) ||
    !!metadataString(metadata, CHANNEL_REACTION_ONLY_ERROR) ||
    !!metadataString(metadata, CHANNEL_REACTION_ONLY_ATTEMPTED)
  )
}

/**
 * Whether this root has an attempted or resolved reaction. An attempt is
 * persisted before its external side effect: after a crash or an unconfirmed
 * outcome, automatically retrying could create a duplicate Feishu reaction.
 */
export function reactionOnlyRootResolved(messages: MessageV2.WithParts[], rootID: string): boolean {
  for (const message of messages) {
    if (message.info.role !== "assistant" || message.info.rootID !== rootID) continue
    if (reactionOnlyResolved(message.info as MessageV2.Assistant)) return true
  }
  return false
}

/**
 * Read the terminal assistant's persisted reaction-only intent. A steer or
 * continuation can produce a later terminal in the same root, whose answer
 * must not inherit an earlier assistant's delivery choice. Durable root
 * markers still prevent retrying a reaction that already resolved.
 */
export function findReactionOnlyIntent(
  messages: MessageV2.WithParts[],
  rootID: string,
  terminalMessageID: string,
): ReactionOnlyIntent | undefined {
  for (const message of messages) {
    if (message.info.role !== "assistant" || message.info.rootID !== rootID || message.info.id !== terminalMessageID)
      continue
    if (message.info.error) return undefined
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== REACTION_ONLY_TOOL || part.state.status !== "completed") continue
      const parsed = ChannelTerminalIntent.safeParse(part.state.metadata.intent)
      if (!parsed.success || parsed.data.type !== "reaction_only") continue
      return { reaction: parsed.data.reaction, partID: part.id }
    }
  }
  return undefined
}

async function recordReactionOnlyMetadata(input: {
  sessionID: string
  terminalMessageID: string
  metadata: Record<string, unknown>
}): Promise<void> {
  await Session.mergeMessageMetadata({
    sessionID: input.sessionID,
    messageID: input.terminalMessageID,
    metadata: input.metadata,
  })
}

/**
 * Record a successful reaction-only delivery. `channelOutboundSent` is set
 * alongside the marker so the outbound bridge and any later terminal update
 * treat the turn as fully delivered.
 */
export async function markReactionOnlyDelivered(input: {
  sessionID: string
  terminalMessageID: string
  reaction: string
}): Promise<void> {
  await recordReactionOnlyMetadata({
    sessionID: input.sessionID,
    terminalMessageID: input.terminalMessageID,
    metadata: {
      [CHANNEL_REACTION_ONLY_DELIVERED]: input.reaction,
      channelOutboundSent: true,
    },
  })
}

/**
 * Record a failed reaction-only delivery. Deliberately does not set
 * `channelOutboundSent`: the turn did not deliver, and the error marker is
 * what keeps the bridge from degrading it into a text reply.
 */
export async function markReactionOnlyFailed(input: {
  sessionID: string
  terminalMessageID: string
  reaction: string
}): Promise<void> {
  await recordReactionOnlyMetadata({
    sessionID: input.sessionID,
    terminalMessageID: input.terminalMessageID,
    metadata: {
      [CHANNEL_REACTION_ONLY_ERROR]: input.reaction,
    },
  })
}

export type ReactionOnlyOutcome =
  | { status: "delivered" }
  | { status: "skipped" }
  | { status: "failed" | "ambiguous"; error: unknown }

export async function executeReactionOnlyDelivery(input: {
  sessionID: string
  rootID: string
  terminalMessageID: string
  reaction: string
  send: () => Promise<void>
}): Promise<ReactionOnlyOutcome> {
  using _ = await Lock.write(`channel-reaction-only:${input.sessionID}:${input.rootID}`)
  const messages = MessageV2.deriveSemantics(await Session.messages({ sessionID: input.sessionID }))
  if (reactionOnlyRootResolved(messages, input.rootID)) return { status: "skipped" }
  try {
    await recordReactionOnlyMetadata({
      ...input,
      metadata: { [CHANNEL_REACTION_ONLY_ATTEMPTED]: input.reaction },
    })
  } catch (error) {
    log.error("reaction-only attempt could not be persisted", { sessionID: input.sessionID, error })
    return { status: "failed", error }
  }
  try {
    await input.send()
  } catch (error) {
    if (
      !(
        error instanceof FeishuReactionError &&
        error.status < 500 &&
        typeof error.code === "number" &&
        error.code !== 0
      )
    ) {
      log.warn("reaction-only provider outcome is uncertain", { sessionID: input.sessionID, error })
      return { status: "ambiguous", error }
    }
    log.error("reaction-only provider rejected delivery", { sessionID: input.sessionID, error })
    try {
      await markReactionOnlyFailed(input)
    } catch (recordError) {
      log.error("failed to confirm reaction-only failure", { sessionID: input.sessionID, error: recordError })
    }
    return { status: "failed", error }
  }
  try {
    await markReactionOnlyDelivered(input)
  } catch (error) {
    log.error("reaction-only outcome is unconfirmed", { sessionID: input.sessionID, error })
    return { status: "ambiguous", error }
  }
  return { status: "delivered" }
}

/**
 * Add the reaction for a reaction-only turn and record the outcome. Used by
 * the outbound bridge, which has no status-reaction controller. Never falls
 * back to a text, card, or attachment reply: the model chose this over
 * answering, so a failure is recorded and surfaced rather than converted.
 */
export async function deliverReactionOnlyReaction(input: {
  provider: Provider
  accountId: string
  messageId: string
  sessionID: string
  rootID: string
  terminalMessageID: string
  reaction: string
}): Promise<ReactionOnlyOutcome> {
  return executeReactionOnlyDelivery({
    ...input,
    send: async () => {
      const addReaction = input.provider.conversation?.addReaction ?? input.provider.addReaction
      if (!addReaction) throw new Error(`Provider "${input.provider.type}" cannot add reactions`)
      await addReaction({
        accountId: input.accountId,
        messageId: input.messageId,
        emoji: input.reaction,
      })
    },
  })
}
