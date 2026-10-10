import z from "zod"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import type { ChannelTerminalIntent } from "../types"
import { isFeishuReactionOnlyAvailable, resolveFeishuReactionOnlyReply } from "../provider/feishu/reaction-only"

const DESCRIPTION = `End the turn with only a reaction on the user's inbound message: add that reaction and send no text, card, attachment, or other message.

Use this only when the message needs no answer at all — a pure acknowledgement, a "seen" or "working on it" signal, or a lightweight confirmation. Anything the user must read — an answer, a question, an error, a decision, or a status they need to act on — must be delivered as a normal reply instead.

Call this tool at most once per turn (one call per user message). After calling it, stop immediately: produce no answer text and make no further tool calls. Calling it again or adding a reply could deliver a reaction AND a text message for the same turn, breaking the reaction-only promise.

This is available only on Feishu accounts with reactionOnlyReply.enabled and streaming disabled; other accounts never offer the tool. The reaction is fixed by the account's reactionOnlyReply.forceReaction setting — you cannot choose one. The reaction is recorded as this turn's terminal intent and the Channel runtime delivers it, so do not also send a reply.`

const Parameters = z.object({})

export const ChannelReactionOnlyTool = Tool.define(
  "channel_reaction_only",
  {
    description: DESCRIPTION,
    parameters: Parameters,
    async execute(params, ctx) {
      ctx.abort.throwIfAborted()
      const session = await Session.get(ctx.sessionID).catch(() => undefined)
      const channel = session?.endpoint?.kind === "channel" ? session.endpoint.channel : undefined
      const accountId = channel?.accountId
      if (!channel || channel.type !== "feishu" || !accountId) {
        throw new Error("The channel_reaction_only tool is only available in Feishu Channel sessions.")
      }

      const cfg = await Config.current().catch(() => undefined)
      const channelConfig = cfg?.channel?.feishu
      if (channelConfig?.type !== "feishu") {
        throw new Error(`The Feishu account "${accountId}" for this session is not configured.`)
      }
      const account = channelConfig.accounts[accountId]
      if (!account) {
        throw new Error(`The Feishu account "${accountId}" for this session is not configured.`)
      }
      if (!isFeishuReactionOnlyAvailable({ account, channel: channelConfig })) {
        throw new Error(
          `The Feishu account "${accountId}" does not allow reaction-only replies. It requires reactionOnlyReply.enabled with streaming disabled.`,
        )
      }

      const reaction = resolveFeishuReactionOnlyReply({ account, channel: channelConfig }).forceReaction
      const intent: ChannelTerminalIntent = { type: "reaction_only", reaction }
      return {
        title: `Reaction only: ${reaction}`,
        output: `Reaction-only intent recorded: the Channel runtime will add the "${reaction}" reaction to the inbound message as this turn's ONLY delivery. The turn is over: stop now, finish with no further output, and wait for the user's next message. Do NOT call this tool again, call any other tool, or write an answer.`,
        metadata: { intent },
      }
    },
  },
  {
    // Reaction-only turns run in Feishu Channel agents whose tool list may not
    // offer expand_tools/search_tools, so a search-mode exposure could leave
    // the tool permanently invisible. Availability is gated by the Channel
    // endpoint and the account's reactionOnlyReply config instead, and the tool
    // re-checks that gate at execution time.
    exposure: {
      mode: "resident",
    },
  },
)
