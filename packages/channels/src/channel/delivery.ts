import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { planChannelDelivery, type ChannelDeliveryPlan } from "./delivery-plan"
import { markChannelTaskAttachmentsDelivered, projectChannelTaskPartsWithUrls } from "./outbound-parts"
import { ResponseCardRuntime } from "./response-card"
import { executeReactionOnlyDelivery, reactionOnlyResolved, type ReactionOnlyOutcome } from "./reaction-only-runtime"
import type { Provider } from "./types"

const log = Log.create({ service: "channel.delivery" })

export async function executeChannelDeliveryPlan(input: {
  sessionID: string
  plan: ChannelDeliveryPlan
  provider: Provider
  accountId: string
  chatId?: string
  chatType?: "dm" | "group"
  scopeKey?: string
  replyToMessageId?: string
  signal?: AbortSignal
  foreground?: {
    close: (text: string | undefined, failed: boolean) => Promise<void>
    ownsReply: boolean
    react: (reaction: string) => Promise<void>
  }
}): Promise<ReactionOnlyOutcome> {
  using _ = await Lock.write(`channel-delivery:${input.sessionID}:${input.plan.rootID}`)
  input.signal?.throwIfAborted()
  const infos = await SessionHistory.turnInfos({ ...input, rootID: input.plan.rootID }).catch((error) => {
    if (error instanceof Storage.NotFoundError) return []
    throw error
  })
  const current = new Map(infos.map((info) => [info.id, info]))
  const terminal = current.get(input.plan.terminal.info.id)
  if (
    !terminal ||
    terminal.role !== "assistant" ||
    terminal.metadata?.channelOutboundSent ||
    reactionOnlyResolved(terminal)
  )
    return { status: "skipped" }
  const [plan] = planChannelDelivery({
    rootID: input.plan.rootID,
    terminalIDs: new Set([terminal.id]),
    replyToMessageId: input.replyToMessageId,
    messages: input.plan.messages.flatMap((message) => {
      const info = current.get(message.info.id)
      return info ? [{ info, parts: message.parts }] : []
    }),
  })
  if (!plan) return { status: "skipped" }
  input.signal?.throwIfAborted()
  if (plan.kind === "reaction") {
    if (input.foreground) await input.foreground.close(undefined, false)
    if (!plan.messageId) return { status: "skipped" }
    return executeReactionOnlyDelivery({
      sessionID: input.sessionID,
      rootID: plan.rootID,
      terminalMessageID: terminal.id,
      reaction: plan.reaction,
      signal: input.signal,
      send: async () => {
        if (input.foreground) return input.foreground.react(plan.reaction)
        const owner = input.provider.conversation
        const addReaction = owner?.addReaction?.bind(owner) ?? input.provider.addReaction?.bind(input.provider)
        if (!addReaction) throw new Error(`Provider "${input.provider.type}" cannot add reactions`)
        await addReaction({ accountId: input.accountId, messageId: plan.messageId!, emoji: plan.reaction })
      },
    })
  }
  const { parts, urls } = await projectChannelTaskPartsWithUrls({
    messages: plan.messages,
    rootID: plan.rootID,
    terminalMessageID: terminal.id,
    includeText: false,
  })
  input.signal?.throwIfAborted()
  if (input.foreground) await input.foreground.close(plan.text || undefined, plan.failed)
  const markSent = () =>
    Session.mergeMessageMetadata({
      sessionID: input.sessionID,
      messageID: terminal.id,
      metadata: { channelOutboundSent: true },
    })
  if (input.foreground?.ownsReply) await markSent()
  if (!input.foreground?.ownsReply && plan.text) parts.unshift({ type: "text", text: plan.text })
  if (parts.length) {
    try {
      const owner = input.provider.conversation
      const replyMessage = owner?.replyMessage?.bind(owner) ?? input.provider.replyMessage?.bind(input.provider)
      const pushMessage = owner?.pushMessage?.bind(owner) ?? input.provider.pushMessage?.bind(input.provider)
      if (input.replyToMessageId) {
        if (!replyMessage) return { status: "skipped" }
        await replyMessage({
          accountId: input.accountId,
          messageId: input.replyToMessageId,
          chatId: input.chatId,
          chatType: input.chatType,
          scopeKey: input.scopeKey,
          parts,
        })
      } else {
        if (!input.chatId || !pushMessage) return { status: "skipped" }
        await pushMessage({ accountId: input.accountId, chatId: input.chatId, parts })
      }
      await markChannelTaskAttachmentsDelivered({ ...input, rootID: plan.rootID, urls, messages: plan.messages })
    } catch (error) {
      if (!input.foreground?.ownsReply) throw error
      log.warn("foreground attachment delivery failed", { sessionID: input.sessionID, error })
    }
  }
  input.signal?.throwIfAborted()
  const cards = await ResponseCardRuntime.deliverTaskCards({
    ...input,
    chatId: input.chatId ?? "",
    terminal: plan.terminal,
    messages: plan.messages,
  }).catch((error) => {
    if (!input.foreground?.ownsReply) throw error
    log.warn("foreground response card delivery failed", { sessionID: input.sessionID, error })
    return false
  })
  if (!parts.length && !cards && !input.foreground?.ownsReply) return { status: "skipped" }
  if (!input.foreground?.ownsReply) await markSent()
  return { status: "delivered" }
}
