import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ChannelTerminalIntent } from "./types"
import type { Provider } from "./types"

const log = Log.create({ service: "channel.reaction-only" })

/** Tool whose completed part carries a reaction-only terminal intent. */
const REACTION_ONLY_TOOL = "channel_reaction_only"

/**
 * Terminal assistant metadata recording that this turn's reaction-only
 * delivery succeeded, holding the emoji that was applied. Its presence is the
 * idempotency guard: Feishu creates a new reaction per call and exposes no
 * "already reacted" error, so a retry after a successful write would stack a
 * second identical reaction on the user's message.
 */
export const CHANNEL_REACTION_ONLY_DELIVERED = "channelReactionOnlyDelivered"

/**
 * Terminal assistant metadata recording a failed reaction-only delivery. It
 * doubles as the retry guard: merging it re-publishes the terminal, which
 * would re-enter the outbound bridge. Marking the attempt stops that loop
 * while leaving the failure visible and never marking the turn delivered.
 */
export const CHANNEL_REACTION_ONLY_ERROR = "channelReactionOnlyError"

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
 * Whether this assistant already resolved a reaction-only turn, either by
 * delivering the reaction or by failing. Both outcomes stop re-delivery: a
 * success must not add a duplicate reaction, and a failure must neither be
 * marked delivered nor fall back to a text reply.
 */
export function reactionOnlyResolved(assistant: MessageV2.Assistant): boolean {
  const metadata = assistant.metadata as Record<string, unknown> | undefined
  return (
    !!metadataString(metadata, CHANNEL_REACTION_ONLY_DELIVERED) ||
    !!metadataString(metadata, CHANNEL_REACTION_ONLY_ERROR)
  )
}

/**
 * Whether any assistant in this task root already resolved the reaction-only
 * turn, by delivering the reaction or by recording its failure. The root then
 * counts as settled for every later scan: no second reaction, and no degraded
 * text fallback on a retry.
 */
export function reactionOnlyRootResolved(messages: MessageV2.WithParts[], rootID: string): boolean {
  for (const message of messages) {
    if (message.info.role !== "assistant" || message.info.rootID !== rootID) continue
    if (reactionOnlyResolved(message.info as MessageV2.Assistant)) return true
  }
  return false
}

/**
 * Find the reaction-only terminal intent for a task tree. Scans completed tool
 * parts the same way `ResponseCardRuntime` collects card requests, so the
 * intent is read from the persisted part rather than in-memory channel state —
 * a queued or recovered turn finds it again after a restart.
 *
 * The intent fires at most once per task root: the tool description tells the
 * model to call it once and stop, but a model that ignores that produces
 * several intent parts and a follow-up terminal. As soon as any assistant in
 * this root is marked delivered or failed, the root is treated as resolved —
 * later scans return no intent so the reaction is never applied a second time.
 */
export function findReactionOnlyIntent(
  messages: MessageV2.WithParts[],
  rootID: string,
): ReactionOnlyIntent | undefined {
  if (reactionOnlyRootResolved(messages, rootID)) return undefined
  for (const message of messages) {
    if (message.info.role !== "assistant" || message.info.rootID !== rootID) continue
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
  try {
    await Session.mergeMessageMetadata({
      sessionID: input.sessionID,
      messageID: input.terminalMessageID,
      metadata: input.metadata,
    })
  } catch (error) {
    log.warn("failed to record reaction-only delivery state", { sessionID: input.sessionID, error })
  }
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

export type ReactionOnlyOutcome = { status: "delivered" } | { status: "failed"; error: unknown }

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
  terminalMessageID: string
  reaction: string
}): Promise<ReactionOnlyOutcome> {
  const addReaction = input.provider.conversation?.addReaction ?? input.provider.addReaction
  if (!addReaction) {
    const error = new Error(`Provider "${input.provider.type}" cannot add reactions`)
    log.error("reaction-only delivery failed", {
      sessionID: input.sessionID,
      messageId: input.messageId,
      reaction: input.reaction,
      error,
    })
    await markReactionOnlyFailed(input)
    return { status: "failed", error }
  }

  try {
    await addReaction({
      accountId: input.accountId,
      messageId: input.messageId,
      emoji: input.reaction,
    })
  } catch (error) {
    log.error("reaction-only delivery failed", {
      sessionID: input.sessionID,
      messageId: input.messageId,
      reaction: input.reaction,
      error,
    })
    await markReactionOnlyFailed(input)
    return { status: "failed", error }
  }

  await markReactionOnlyDelivered(input)
  log.info("reaction-only turn delivered", {
    sessionID: input.sessionID,
    messageId: input.messageId,
    reaction: input.reaction,
  })
  return { status: "delivered" }
}
