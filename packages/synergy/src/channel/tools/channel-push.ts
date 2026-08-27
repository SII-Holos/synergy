import z from "zod"
import { Channel } from "@/channel"
import { Session } from "../../session"
import { Tool } from "../../tool/tool"
import DESCRIPTION from "./channel-push.txt"

const parameters = z.object({
  text: z.string().min(1).describe("Text to push to the channel chat."),
  accountId: z.string().optional().describe("Channel account ID. Defaults to the session's channel endpoint."),
  chatId: z.string().optional().describe("Target chat (group or DM) ID. Defaults to the session's channel endpoint."),
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
    const accountId = params.accountId ?? channel.accountId
    if (!accountId) {
      throw new Error("channel_push: session channel endpoint has no accountId")
    }
    const chatId = params.chatId ?? channel.chatId
    if (!chatId) {
      throw new Error("channel_push: session channel endpoint has no chatId")
    }
    // Only boss-role sessions may push to channels; ordinary sessions
    // already auto-reply through the outbound bridge for their own messages.
    const workflow = session.workflow
    if (workflow?.kind !== "boss" || workflow.role !== "boss") {
      throw new Error("channel_push: only boss-role sessions may push to channels")
    }
    // Sending as the configured bot crosses the user's communication
    // boundary; require an explicit permission decision for the target chat.
    await ctx.ask({
      permission: "communication",
      patterns: [chatId],
      metadata: { accountId, chatId, replyToMessageId: params.replyToMessageId },
    })

    const parts = [{ type: "text" as const, text: params.text }]
    if (params.replyToMessageId) {
      const reply = provider.conversation?.replyMessage ?? provider.replyMessage
      if (!reply) {
        throw new Error(`channel_push: provider "${channel.type}" does not support replyMessage`)
      }
      await reply({
        accountId,
        messageId: params.replyToMessageId,
        chatId,
        chatType: channel.chatType,
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
