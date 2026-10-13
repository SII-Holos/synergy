import { z } from "zod"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { ConfigExtensions } from "@ericsanchezok/synergy-harness/config/extensions"
import { FeishuReactionEmoji } from "./channel/provider/feishu/reaction-only"
export const FeishuGroupSessionScope = z
  .enum(["group", "group_sender", "group_topic", "group_topic_sender", "group_thread"])
  .describe(
    "How group chat sessions are scoped: group = shared, group_sender = per sender, group_topic = per topic, group_topic_sender = per topic+sender, group_thread = one session per Feishu thread or top-level request",
  )

export type FeishuGroupSessionScope = z.infer<typeof FeishuGroupSessionScope>

export const ChannelFeishuAccount = z
  .object({
    enabled: z.boolean().optional().default(true),
    appId: z.string().describe("Feishu app ID"),
    appSecret: z.string().describe("Feishu app secret"),
    domain: z.enum(["feishu", "lark"]).optional().describe("Feishu domain (feishu for China, lark for international)"),
    allowDM: z.boolean().optional().default(true).describe("Allow direct messages"),
    allowGroup: z.boolean().optional().default(true).describe("Allow group messages"),
    requireMention: z.boolean().optional().default(true).describe("Require @mention in group chats"),
    botOpenId: z.string().optional().describe("Bot open_id used to verify real @mentions in group chats"),
    projectDir: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Project directory whose Scope owns sessions for this Feishu account"),
    streaming: z.boolean().optional().describe("Enable streaming card updates"),
    responseFormat: z
      .enum(["text", "markdown"])
      .optional()
      .describe("Format for ordinary outbound text messages (markdown renders through a CardKit card)"),
    streamingThrottleMs: z
      .number()
      .int()
      .positive()
      .optional()
      .default(100)
      .describe("Minimum interval between streaming card updates in ms"),
    groupSessionScope: FeishuGroupSessionScope.optional()
      .default("group")
      .describe("Session scoping strategy for group chats"),
    inboundDebounceMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(0)
      .describe("Debounce rapid-fire messages from the same sender in the same chat (0 = disabled)"),
    model: z
      .string()
      .optional()
      .describe("Model to use for this account in providerID/modelID format (e.g. openai/gpt-4o)"),
    variant: z.string().optional().describe("Model variant to use with this account model (e.g. low, high, max)"),
    resolveSenderNames: z
      .boolean()
      .optional()
      .default(true)
      .describe("Resolve sender display names via Feishu contact API"),
    replyInThread: z.boolean().optional().default(false).describe("Reply in thread when message is part of a topic"),
    reactionOnlyReply: z
      .object({
        enabled: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Let the model end a turn with a reaction on the inbound message instead of a reply (non-streaming accounts only)",
          ),
        forceReaction: FeishuReactionEmoji.optional().describe(
          "Feishu emoji_type forced for every reaction-only turn; the model cannot choose one",
        ),
      })
      .strict()
      .optional()
      .describe("Reaction-only terminal delivery for this Feishu account; disabled unless enabled is true"),
  })
  .strict()
  .meta({ ref: "ChannelFeishuAccountConfig" })

export type ChannelFeishuAccount = z.infer<typeof ChannelFeishuAccount>

export const ChannelFeishu = z
  .object({
    type: z.literal("feishu"),
    accounts: z.record(z.string(), ChannelFeishuAccount),
    domain: z.enum(["feishu", "lark"]).optional().describe("Default domain for all accounts"),
    streaming: z.boolean().optional().default(true).describe("Default streaming setting for all accounts"),
    responseFormat: z
      .enum(["text", "markdown"])
      .optional()
      .default("markdown")
      .describe("Default outbound text format for all accounts"),
  })
  .strict()
  .meta({ ref: "ChannelFeishuConfig" })

export type ChannelFeishu = z.infer<typeof ChannelFeishu>

import { ChannelConfigRegistry } from "@ericsanchezok/synergy-channels/config-schema"
declare module "@ericsanchezok/synergy-channels/config-schema" {
  interface ChannelKinds {
    feishu: ChannelFeishu
  }
}
export function registerConfig() {
  ChannelConfigRegistry.register("feishu", ChannelFeishu)
  ConfigExtensions.register("channel-feishu-secrets", {
    shape: {},
    references(raw, providerID) {
      const result: string[] = []
      const channels = raw.channel as Record<string, unknown> | undefined
      for (const [id, value] of Object.entries(channels ?? {})) {
        const config = ChannelFeishu.safeParse(value)
        if (!config.success) continue
        for (const [key, account] of Object.entries(config.data.accounts))
          if (account.model?.startsWith(`${providerID}/`)) result.push(`channel.${id}.accounts.${key}.model`)
      }
      return result
    },
    redact(raw, helpers) {
      const channels = raw.channel as Record<string, ChannelFeishu> | undefined
      for (const config of Object.values(channels ?? {})) {
        if (config.type !== "feishu") continue
        for (const account of Object.values(config.accounts))
          if (account.appSecret) account.appSecret = helpers.sentinel
      }
    },
    restore(raw, previous, helpers) {
      const channels = raw.channel as Record<string, ChannelFeishu> | undefined
      const old = previous.channel as Record<string, ChannelFeishu> | undefined
      for (const [id, config] of Object.entries(channels ?? {})) {
        if (config.type !== "feishu") continue
        for (const [key, account] of Object.entries(config.accounts)) {
          const stored = old?.[id]?.accounts?.[key]
          if (account.appSecret === helpers.sentinel && stored?.appSecret) account.appSecret = stored.appSecret
        }
      }
    },
  })
}
