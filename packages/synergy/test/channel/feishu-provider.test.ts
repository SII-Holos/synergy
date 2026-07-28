import { describe, expect, test } from "bun:test"
import { Asset } from "../../src/asset/asset"
import {
  FeishuProvider,
  filterInboundMessage,
  isSelfSender,
  isOwnBotMessage,
  normalizeBotOpenId,
  resolveSenderOpenId,
  isBotMentioned,
  resolveGroupScopeKey,
} from "../../src/channel/provider/feishu"
import { mergeStreamingText } from "../../src/channel/provider/feishu/streaming-card"
import { createStatusReactionController } from "../../src/channel/status-reactions"
import type { StreamingSession } from "../../src/channel/types"
import type { Config } from "../../src/config/config"

function accountConfig(overrides: Partial<Config.ChannelFeishuAccount> = {}): Config.ChannelFeishuAccount {
  return {
    enabled: true,
    appId: "app",
    appSecret: "secret",
    allowDM: true,
    allowGroup: true,
    requireMention: false,
    streaming: true,
    streamingThrottleMs: 100,
    groupSessionScope: "group",
    inboundDebounceMs: 0,
    resolveSenderNames: false,
    replyInThread: false,
    ...overrides,
  }
}

describe("isSelfSender", () => {
  test("returns true for app/bot/app_bot sender types", () => {
    expect(isSelfSender("app")).toBe(true)
    expect(isSelfSender("bot")).toBe(true)
    expect(isSelfSender("app_bot")).toBe(true)
    expect(isSelfSender("APP")).toBe(true)
    expect(isSelfSender("Bot")).toBe(true)
  })

  test("returns false for user sender types", () => {
    expect(isSelfSender("user")).toBe(false)
    expect(isSelfSender(undefined)).toBe(false)
    expect(isSelfSender("")).toBe(false)
  })
})

describe("isOwnBotMessage", () => {
  test("returns true only when a bot sender matches the known bot open_id", () => {
    expect(isOwnBotMessage({ sender_id: { open_id: "ou_synergy" }, sender_type: "bot" }, "ou_synergy")).toBe(true)
    expect(isOwnBotMessage({ sender_id: { open_id: "ou_chaos" }, sender_type: "bot" }, "ou_synergy")).toBe(false)
  })

  test("preserves the safe legacy fallback when the bot open_id is unknown", () => {
    expect(isOwnBotMessage({ sender_id: { open_id: "ou_chaos" }, sender_type: "bot" }, undefined)).toBe(true)
    expect(isOwnBotMessage({ sender_id: { open_id: "ou_user" }, sender_type: "user" }, undefined)).toBe(false)
  })

  test("fails closed when a bot sender has no resolvable open_id", () => {
    expect(isOwnBotMessage({ sender_id: {}, sender_type: "bot" }, "ou_synergy")).toBe(true)
  })
})

describe("normalizeBotOpenId", () => {
  test("trims whitespace and returns undefined for empty", () => {
    expect(normalizeBotOpenId("ou_bot")).toBe("ou_bot")
    expect(normalizeBotOpenId("  ou_bot  ")).toBe("ou_bot")
    expect(normalizeBotOpenId("")).toBeUndefined()
    expect(normalizeBotOpenId("  ")).toBeUndefined()
    expect(normalizeBotOpenId(undefined)).toBeUndefined()
  })
})

describe("resolveSenderOpenId", () => {
  test("extracts open_id from sender", () => {
    expect(resolveSenderOpenId({ sender_id: { open_id: "ou_123" } })).toBe("ou_123")
    expect(resolveSenderOpenId({ sender_id: {} })).toBeUndefined()
    expect(resolveSenderOpenId(undefined)).toBeUndefined()
  })
})

describe("isBotMentioned", () => {
  test("returns true when bot open_id is in mentions", () => {
    const mentions = [
      { key: "@_user_1", id: { open_id: "ou_bot" }, name: "Bot" },
      { key: "@_user_2", id: { open_id: "ou_other" }, name: "Other" },
    ]
    expect(isBotMentioned(mentions, "ou_bot")).toBe(true)
  })

  test("returns false when bot open_id is not in mentions", () => {
    const mentions = [{ key: "@_user_1", id: { open_id: "ou_other" }, name: "Other" }]
    expect(isBotMentioned(mentions, "ou_bot")).toBe(false)
  })

  test("returns false when botOpenId is undefined", () => {
    const mentions = [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Bot" }]
    expect(isBotMentioned(mentions, undefined)).toBe(false)
  })

  test("handles whitespace in mention open_ids", () => {
    const mentions = [{ key: "@_user_1", id: { open_id: " ou_bot " }, name: "Bot" }]
    expect(isBotMentioned(mentions, "ou_bot")).toBe(true)
  })
})

describe("resolveGroupScopeKey", () => {
  test("group scope returns chatId", () => {
    expect(resolveGroupScopeKey({ chatId: "c1", senderId: "s1", scope: "group" })).toBe("c1")
  })

  test("group_sender scope includes senderId", () => {
    expect(resolveGroupScopeKey({ chatId: "c1", senderId: "s1", scope: "group_sender" })).toBe("c1:sender:s1")
  })

  test("group_topic scope uses rootId when present", () => {
    expect(resolveGroupScopeKey({ chatId: "c1", senderId: "s1", rootId: "r1", scope: "group_topic" })).toBe(
      "c1:topic:r1",
    )
  })

  test("group_topic scope falls back to threadId", () => {
    expect(resolveGroupScopeKey({ chatId: "c1", senderId: "s1", threadId: "t1", scope: "group_topic" })).toBe(
      "c1:topic:t1",
    )
  })

  test("group_topic scope returns chatId when no topic", () => {
    expect(resolveGroupScopeKey({ chatId: "c1", senderId: "s1", scope: "group_topic" })).toBe("c1")
  })

  test("group_topic_sender combines topic and sender", () => {
    expect(resolveGroupScopeKey({ chatId: "c1", senderId: "s1", rootId: "r1", scope: "group_topic_sender" })).toBe(
      "c1:topic:r1:sender:s1",
    )
  })

  test("group_topic_sender falls back to sender when no topic", () => {
    expect(resolveGroupScopeKey({ chatId: "c1", senderId: "s1", scope: "group_topic_sender" })).toBe("c1:sender:s1")
  })
})

describe("filterInboundMessage", () => {
  test("rejects when message is undefined", () => {
    const result = filterInboundMessage({
      message: undefined,
      sender: undefined,
      accountConfig: accountConfig(),
    })
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("missing chat_id")
  })

  test("rejects when message has no chat_id", () => {
    const result = filterInboundMessage({
      message: { message_type: "text" },
      sender: undefined,
      accountConfig: accountConfig(),
    })
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("missing chat_id")
  })

  test("rejects self-sent bot/app messages", () => {
    const result = filterInboundMessage({
      message: { chat_id: "chat_1", chat_type: "p2p", message_type: "text" },
      sender: { sender_id: { open_id: "ou_bot" }, sender_type: "app" },
      accountConfig: accountConfig(),
    })
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("self sender")
  })

  test("accepts external bot DM messages when the bot identity is known", () => {
    const result = filterInboundMessage({
      message: { chat_id: "chat_1", chat_type: "p2p", message_type: "text" },
      sender: { sender_id: { open_id: "ou_chaos" }, sender_type: "bot" },
      accountConfig: accountConfig(),
      botOpenId: "ou_synergy",
    })
    expect(result.accepted).toBe(true)
    expect(result.isGroup).toBe(false)
  })

  test("rejects own bot messages when the sender matches the bot identity", () => {
    const result = filterInboundMessage({
      message: { chat_id: "chat_1", chat_type: "group", message_type: "text" },
      sender: { sender_id: { open_id: "ou_synergy" }, sender_type: "bot" },
      accountConfig: accountConfig(),
      botOpenId: "ou_synergy",
    })
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("self sender")
  })

  test("accepts normal user DM messages", () => {
    const result = filterInboundMessage({
      message: { chat_id: "chat_1", chat_type: "p2p", message_type: "text" },
      sender: { sender_id: { open_id: "ou_user" }, sender_type: "user" },
      accountConfig: accountConfig(),
    })
    expect(result.accepted).toBe(true)
    expect(result.isGroup).toBe(false)
  })

  test("rejects group messages when allowGroup is false", () => {
    const result = filterInboundMessage({
      message: { chat_id: "chat_1", chat_type: "group", message_type: "text" },
      sender: { sender_id: { open_id: "ou_user" }, sender_type: "user" },
      accountConfig: accountConfig({ allowGroup: false }),
    })
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("group not allowed")
  })

  test("rejects DM messages when allowDM is false", () => {
    const result = filterInboundMessage({
      message: { chat_id: "chat_1", chat_type: "p2p", message_type: "text" },
      sender: { sender_id: { open_id: "ou_user" }, sender_type: "user" },
      accountConfig: accountConfig({ allowDM: false }),
    })
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("DM not allowed")
  })

  test("rejects group message when requireMention is true but bot not mentioned", () => {
    const result = filterInboundMessage({
      message: {
        chat_id: "chat_1",
        chat_type: "group",
        message_type: "text",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_other" }, name: "Other" }],
      },
      sender: { sender_id: { open_id: "ou_user" }, sender_type: "user" },
      accountConfig: accountConfig({ requireMention: true }),
      botOpenId: "ou_bot",
    })
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("bot not mentioned")
  })

  test("accepts group message when bot is mentioned", () => {
    const result = filterInboundMessage({
      message: {
        chat_id: "chat_1",
        chat_type: "group",
        message_type: "text",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Synergy" }],
      },
      sender: { sender_id: { open_id: "ou_user" }, sender_type: "user" },
      accountConfig: accountConfig({ requireMention: true }),
      botOpenId: "ou_bot",
    })
    expect(result.accepted).toBe(true)
    expect(result.isGroup).toBe(true)
    expect(result.wasMentioned).toBe(true)
  })

  test("accepts a mentioned external bot in a requireMention group", () => {
    const result = filterInboundMessage({
      message: {
        chat_id: "chat_1",
        chat_type: "group",
        message_type: "text",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_synergy" }, name: "Synergy" }],
      },
      sender: { sender_id: { open_id: "ou_chaos" }, sender_type: "bot" },
      accountConfig: accountConfig({ requireMention: true }),
      botOpenId: "ou_synergy",
    })
    expect(result.accepted).toBe(true)
    expect(result.wasMentioned).toBe(true)
  })

  test("rejects an unmentioned external bot in a requireMention group", () => {
    const result = filterInboundMessage({
      message: {
        chat_id: "chat_1",
        chat_type: "group",
        message_type: "text",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_reporter" }, name: "Reporter" }],
      },
      sender: { sender_id: { open_id: "ou_chaos" }, sender_type: "bot" },
      accountConfig: accountConfig({ requireMention: true }),
      botOpenId: "ou_synergy",
    })
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("bot not mentioned")
  })

  test("rejects group message when requireMention but no botOpenId available", () => {
    const result = filterInboundMessage({
      message: {
        chat_id: "chat_1",
        chat_type: "group",
        message_type: "text",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Synergy" }],
      },
      sender: { sender_id: { open_id: "ou_user" }, sender_type: "user" },
      accountConfig: accountConfig({ requireMention: true }),
      botOpenId: undefined,
    })
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("bot open_id unresolvable")
    expect(result.needsBotOpenIdResolution).toBe(true)
  })

  test("group message without requireMention is accepted even without botOpenId", () => {
    const result = filterInboundMessage({
      message: { chat_id: "chat_1", chat_type: "group", message_type: "text" },
      sender: { sender_id: { open_id: "ou_user" }, sender_type: "user" },
      accountConfig: accountConfig({ requireMention: false }),
    })
    expect(result.accepted).toBe(true)
    expect(result.isGroup).toBe(true)
    expect(result.wasMentioned).toBe(false)
  })
})

describe("Feishu replies", () => {
  test("requests a threaded reply when the account enables replyInThread", async () => {
    const originalFetch = globalThis.fetch
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ code: 0, data: { message_id: "msg_reply" } }), {
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    try {
      const provider = new FeishuProvider()
      const accounts = (
        provider as unknown as {
          accounts: Map<string, unknown>
        }
      ).accounts
      accounts.set("acct_test", {
        config: accountConfig({ replyInThread: true }),
        channelConfig: {},
        apiBase: "https://open.feishu.test/open-apis",
        tokenCache: { token: "token_test", expiresAt: Date.now() + 120_000 },
      })

      await provider.replyMessage({
        accountId: "acct_test",
        messageId: "msg_topic_root",
        parts: [{ type: "text", text: "Background work finished" }],
      })

      expect(requestBody).toMatchObject({
        msg_type: "text",
        reply_in_thread: true,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("uploads SVG attachments as files instead of unsupported Feishu images", async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      requests.push({ url, body: init?.body })
      if (url.endsWith("/im/v1/files")) {
        return new Response(JSON.stringify({ code: 0, data: { file_key: "file_svg" } }), {
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: "msg_reply" } }), {
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    try {
      const assetID = await Asset.write(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"></svg>'),
        "image/svg+xml",
        "meme.svg",
      )
      const provider = new FeishuProvider()
      const accounts = (
        provider as unknown as {
          accounts: Map<string, unknown>
        }
      ).accounts
      accounts.set("acct_test", {
        config: accountConfig(),
        channelConfig: {},
        apiBase: "https://open.feishu.test/open-apis",
        tokenCache: { token: "token_test", expiresAt: Date.now() + 120_000 },
      })

      await provider.replyMessage({
        accountId: "acct_test",
        messageId: "msg_topic_root",
        parts: [
          {
            type: "file",
            path: Asset.resolvePath(assetID),
            filename: "meme.svg",
            contentType: "image/svg+xml",
          },
        ],
      })

      expect(requests.map((request) => request.url)).toEqual([
        "https://open.feishu.test/open-apis/im/v1/files",
        "https://open.feishu.test/open-apis/im/v1/messages/msg_topic_root/reply",
      ])
      expect(requests.some((request) => request.url.endsWith("/im/v1/images"))).toBe(false)
      const upload = requests[0]?.body
      expect(upload).toBeInstanceOf(FormData)
      expect((upload as FormData).get("file_type")).toBe("stream")
      expect((upload as FormData).get("file_name")).toBe("meme.svg")
      const reply = JSON.parse(String(requests[1]?.body)) as Record<string, unknown>
      expect(reply).toMatchObject({
        msg_type: "file",
        content: JSON.stringify({ file_key: "file_svg" }),
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("Feishu streaming merge", () => {
  test("keeps existing text when a non-prefix rewrite arrives", () => {
    expect(
      mergeStreamingText(
        "不过我需要先确认一下：你所在的城市是哪里？这样我才能为你查询准确的天气预报",
        "太好了！我来为你设置每天早上八点的上海天气提醒。",
      ),
    ).toBe("不过我需要先确认一下：你所在的城市是哪里？这样我才能为你查询准确的天气预报")
  })

  test("preserves normal incremental streaming growth", () => {
    expect(mergeStreamingText("太好了！我来", "太好了！我来为你设置天气提醒。")).toBe("太好了！我来为你设置天气提醒。")
  })

  test("keeps prior content when chunks only overlap but are not a prefix extension", () => {
    expect(mergeStreamingText("上海天气提醒，", "提醒，包含天气状况、温度和风力。")).toBe("上海天气提醒，")
  })
})

describe("Streaming session compatibility", () => {
  test("providers expose tool progress update hook", () => {
    const session: StreamingSession = {
      async start() {},
      async update() {},
      async updateToolProgress() {},
      async close() {},
      isActive() {
        return true
      },
    }

    expect(typeof session.updateToolProgress).toBe("function")
  })
})

describe("Feishu tool progress titles", () => {
  test("tool progress titles are localized to English by state", async () => {
    const cardModule = await import("../../src/channel/provider/feishu/streaming-card")
    const render = (
      cardModule as unknown as {
        renderToolProgress?: (
          progress: Array<{
            id: string
            tool: string
            title?: string
            status: "pending" | "running" | "completed" | "error"
          }>,
        ) => string
      }
    ).renderToolProgress

    expect(render).toBeDefined()
    expect(render?.([{ id: "1", tool: "websearch", status: "running" }])).toContain("**Tools · Working**")
    expect(render?.([{ id: "1", tool: "websearch", status: "completed" }])).toContain("**Tools · Completed**")
    expect(render?.([{ id: "1", tool: "websearch", status: "error" }])).toContain("**Tools · Completed with errors**")
  })
})

describe("Channel status reactions", () => {
  test("replaces prior reaction when adapter supports removal", async () => {
    const calls: Array<{ method: string; value: string }> = []
    const controller = createStatusReactionController({
      adapter: {
        async setReaction(emoji) {
          calls.push({ method: "set", value: emoji })
          return `${emoji}-id`
        },
        async removeReaction(reactionId) {
          calls.push({ method: "remove", value: reactionId })
        },
      },
    })

    await controller.setQueued()
    await controller.setDone()

    expect(calls).toEqual([
      { method: "set", value: "Typing" },
      { method: "set", value: "DONE" },
      { method: "remove", value: "Typing-id" },
    ])
  })
})
