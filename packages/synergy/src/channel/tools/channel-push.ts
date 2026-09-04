import z from "zod"
import { Channel } from "@/channel"
import { Session } from "../../session"
import { MessageV2 } from "../../session/message-v2"
import { Tool } from "../../tool/tool"
import DESCRIPTION from "./channel-push.txt"

const parameters = z.object({
  text: z.string().min(1).describe("Text to push to the channel chat."),
  accountId: z.string().optional().describe("Channel account ID. Defaults to the session's channel endpoint."),
  chatId: z
    .string()
    .optional()
    .describe("Target chat (group or DM) ID. Defaults to the chat the current message arrived from."),
  replyToMessageId: z.string().optional().describe("Reply to this message ID instead of pushing a new message."),
})

export const ChannelPushTool = Tool.define("channel_push", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const session = await Session.get(ctx.sessionID)
    if (session?.endpoint?.kind !== "channel") {
      throw new Error("channel_push: session has no channel endpoint")
    }
    const { channel } = session.endpoint
    const provider = Channel.getProvider(channel.type)
    if (!provider) {
      throw new Error(`channel_push: no channel provider registered for "${channel.type}"`)
    }
    const workflow = session.workflow
    if (workflow?.kind !== "boss" || workflow.role !== "boss") {
      throw new Error("channel_push: only boss-role sessions may push to channels")
    }

    // Resolve the chat the current inbound message arrived from. The
    // provisioned runtime boss endpoint stores a sentinel chat id ("boss"),
    // so the real chat travels on the root user message of the turn the boss
    // is answering (channelChatId / channelChatType, persisted by the channel
    // acceptance path). Reply targeting must use that metadata, never the
    // endpoint chat id.
    const assistant = await MessageV2.get({
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
    }).catch(() => undefined)
    const rootMessageID =
      assistant?.info.role === "assistant" ? (assistant.info.rootID ?? assistant.info.parentID) : undefined
    const root =
      rootMessageID === undefined
        ? undefined
        : await MessageV2.get({ sessionID: ctx.sessionID, messageID: rootMessageID }).catch(() => undefined)
    const rootMetadata = root?.info.role === "user" ? root.info.metadata : undefined
    const inboundChatId =
      typeof rootMetadata?.channelChatId === "string" && rootMetadata.channelChatId.trim()
        ? rootMetadata.channelChatId
        : undefined
    const inboundChatType =
      rootMetadata?.channelChatType === "dm" || rootMetadata?.channelChatType === "group"
        ? rootMetadata.channelChatType
        : undefined

    const accountId = params.accountId ?? channel.accountId
    if (!accountId) {
      throw new Error("channel_push: session channel endpoint has no accountId")
    }
    // Default to the chat this turn is answering. A proactive push (no
    // inbound message for this turn) must name its target explicitly.
    const chatId = params.chatId ?? inboundChatId
    if (!chatId) {
      throw new Error(
        "channel_push: no target chat — pass chatId explicitly when pushing without an inbound channel message",
      )
    }

    // R6 answer path: replying inside the chat the current inbound message
    // arrived from, with the session's own account and a reply anchor, is
    // answering the user and needs no permission prompt. Anything else —
    // another chat, another account, or an unanchored new message — crosses
    // the communication boundary and still requires an explicit decision.
    const sameAccount = accountId === channel.accountId
    const sameChat = inboundChatId !== undefined && chatId === inboundChatId
    const anchoredReply = params.replyToMessageId !== undefined
    if (!(sameAccount && sameChat && anchoredReply)) {
      await ctx.ask({
        permission: "communication",
        patterns: [chatId],
        metadata: { accountId, chatId, replyToMessageId: params.replyToMessageId },
      })
    }

    const parts = [{ type: "text" as const, text: params.text }]
    if (params.replyToMessageId) {
      const reply = provider.conversation?.replyMessage ?? provider.replyMessage
      if (!reply) {
        throw new Error(`channel_push: provider "${channel.type}" does not support replyMessage`)
      }
      // Prefer the inbound chat type for replies (a DM reply must not be
      // sent with the endpoint's aggregate group type); fall back to the
      // endpoint type for cross-chat replies.
      const chatType = sameChat && inboundChatType ? inboundChatType : channel.chatType
      await reply({
        accountId,
        messageId: params.replyToMessageId,
        chatId,
        chatType,
        parts,
        scopeKey: channel.scopeKey,
      })
      return {
        title: "Message pushed to channel",
        metadata: {
          accountId,
          chatId,
          ...(params.replyToMessageId ? { replyToMessageId: params.replyToMessageId } : {}),
        },
        output: `Replied to message ${params.replyToMessageId} in chat ${chatId}.`,
      }
    }

    const push = provider.conversation?.pushMessage ?? provider.pushMessage
    if (!push) {
      throw new Error(`channel_push: provider "${channel.type}" does not support pushMessage`)
    }
    const result = await push({ accountId, chatId, parts })
    return {
      title: "Message pushed to channel",
      metadata: { accountId, chatId },
      output: `Pushed message to chat ${chatId}${result.messageId ? ` (message ${result.messageId})` : ""}.`,
    }
  },
})
