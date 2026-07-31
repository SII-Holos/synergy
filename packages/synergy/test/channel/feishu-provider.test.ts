import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
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
import { createStatusReactionController } from "../../src/channel/status-reactions"
import type { StreamingSession } from "../../src/channel/types"
import { Config } from "../../src/config/config"

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

describe("Feishu streaming configuration", () => {
  test("preserves an omitted account setting so the provider default can apply", () => {
    const provider = Config.ChannelFeishu.parse({
      type: "feishu",
      streaming: false,
      accounts: {
        default: {
          appId: "app",
          appSecret: "secret",
        },
      },
    })

    expect(provider.streaming).toBe(false)
    expect(provider.accounts.default?.streaming).toBeUndefined()
  })

  test("defaults provider responseFormat to markdown while preserving an omitted account setting", () => {
    const provider = Config.ChannelFeishu.parse({
      type: "feishu",
      accounts: {
        default: {
          appId: "app",
          appSecret: "secret",
        },
      },
    })

    expect(provider.responseFormat).toBe("markdown")
    expect(provider.accounts.default?.responseFormat).toBeUndefined()
  })
})

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
    let request: { body?: Record<string, unknown>; signal?: AbortSignal | null } = {}
    globalThis.fetch = (async (_input, init) => {
      request = {
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        signal: init?.signal,
      }
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
        config: accountConfig({ replyInThread: true, responseFormat: "text" }),
        channelConfig: {},
        apiBase: "https://open.feishu.test/open-apis",
        tokenCache: { token: "token_test", expiresAt: Date.now() + 120_000 },
      })

      await provider.replyMessage({
        accountId: "acct_test",
        messageId: "msg_topic_root",
        parts: [{ type: "text", text: "Background work finished" }],
      })

      expect(request.body).toMatchObject({
        msg_type: "text",
        reply_in_thread: true,
      })
      expect(request.signal).toBeInstanceOf(AbortSignal)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("uploads SVG attachments as files instead of unsupported Feishu images", async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; body: unknown; signal?: AbortSignal | null }> = []
    let assetPath: string | undefined
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      requests.push({ url, body: init?.body, signal: init?.signal })
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
      assetPath = Asset.resolvePath(assetID)
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
            path: assetPath,
            filename: "meme.svg",
            contentType: "image/svg+xml",
          },
        ],
      })

      expect(requests.map((request) => request.url)).toEqual([
        "https://open.feishu.test/open-apis/im/v1/files",
        "https://open.feishu.test/open-apis/im/v1/messages/msg_topic_root/reply",
      ])
      expect(requests.every((request) => request.signal instanceof AbortSignal)).toBe(true)
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
      if (assetPath) await fs.rm(assetPath, { force: true })
    }
  })
})

describe("Feishu markdown replies", () => {
  function markdownAccount(overrides: Partial<Config.ChannelFeishuAccount> = {}) {
    return {
      config: accountConfig(overrides),
      channelConfig: {},
      apiBase: "https://open.feishu.test/open-apis",
      tokenCache: { token: "token_test", expiresAt: Date.now() + 120_000 },
    }
  }

  function mockCardFlow(requests: Array<{ url: string; body: Record<string, unknown> }>) {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      requests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      if (url.endsWith("/cardkit/v1/cards")) {
        return new Response(JSON.stringify({ code: 0, data: { card_id: "card_md" } }), {
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: "msg_reply" } }), {
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch
    return originalFetch
  }

  test("sends text replies as a CardKit markdown card by default", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const originalFetch = mockCardFlow(requests)

    try {
      const provider = new FeishuProvider()
      const accounts = (provider as unknown as { accounts: Map<string, unknown> }).accounts
      accounts.set("acct_md", markdownAccount())

      await provider.replyMessage({
        accountId: "acct_md",
        messageId: "msg_root",
        parts: [{ type: "text", text: "**bold** answer with `code`" }],
      })

      expect(requests.map((request) => request.url)).toEqual([
        "https://open.feishu.test/open-apis/cardkit/v1/cards",
        "https://open.feishu.test/open-apis/im/v1/messages/msg_root/reply",
      ])
      const cardJson = JSON.parse(String(requests[0]?.body.data)) as {
        body: { elements: Array<{ tag: string; content: string }> }
      }
      expect(cardJson.body.elements[0]?.tag).toBe("markdown")
      expect(cardJson.body.elements[0]?.content).toBe("**bold** answer with `code`")
      const reply = requests[1]?.body
      expect(reply?.msg_type).toBe("interactive")
      expect(JSON.parse(String(reply?.content))).toEqual({ type: "card", data: { card_id: "card_md" } })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("sends pushed text as a markdown card by default", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const originalFetch = mockCardFlow(requests)

    try {
      const provider = new FeishuProvider()
      const accounts = (provider as unknown as { accounts: Map<string, unknown> }).accounts
      accounts.set("acct_md", markdownAccount())

      await provider.pushMessage({
        accountId: "acct_md",
        chatId: "chat_1",
        parts: [{ type: "text", text: "pushed **markdown**" }],
      })

      expect(requests.map((request) => request.url)).toEqual([
        "https://open.feishu.test/open-apis/cardkit/v1/cards",
        "https://open.feishu.test/open-apis/im/v1/messages?receive_id_type=chat_id",
      ])
      const create = requests[1]?.body
      expect(create?.receive_id).toBe("chat_1")
      expect(create?.msg_type).toBe("interactive")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("keeps plain text replies when the account sets responseFormat text", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const originalFetch = mockCardFlow(requests)

    try {
      const provider = new FeishuProvider()
      const accounts = (provider as unknown as { accounts: Map<string, unknown> }).accounts
      accounts.set("acct_text", markdownAccount({ responseFormat: "text" }))

      await provider.replyMessage({
        accountId: "acct_text",
        messageId: "msg_root",
        parts: [{ type: "text", text: "**bold** stays raw" }],
      })

      expect(requests.map((request) => request.url)).toEqual([
        "https://open.feishu.test/open-apis/im/v1/messages/msg_root/reply",
      ])
      expect(requests[0]?.body.msg_type).toBe("text")
      expect(JSON.parse(String(requests[0]?.body.content))).toEqual({ text: "**bold** stays raw" })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("honors the provider-level responseFormat when the account omits it", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const originalFetch = mockCardFlow(requests)

    try {
      const provider = new FeishuProvider()
      const accounts = (provider as unknown as { accounts: Map<string, unknown> }).accounts
      accounts.set("acct_provider_text", {
        ...markdownAccount(),
        channelConfig: { responseFormat: "text" },
      })

      await provider.replyMessage({
        accountId: "acct_provider_text",
        messageId: "msg_root",
        parts: [{ type: "text", text: "plain" }],
      })

      expect(requests.map((request) => request.url)).toEqual([
        "https://open.feishu.test/open-apis/im/v1/messages/msg_root/reply",
      ])
      expect(requests[0]?.body.msg_type).toBe("text")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("falls back to plain text when the markdown card API fails", async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      requests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      if (url.endsWith("/cardkit/v1/cards")) {
        return new Response(JSON.stringify({ code: 500, msg: "card unavailable" }), {
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: "msg_reply" } }), {
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    try {
      const provider = new FeishuProvider()
      const accounts = (provider as unknown as { accounts: Map<string, unknown> }).accounts
      accounts.set("acct_fallback", markdownAccount())

      const result = await provider.replyMessage({
        accountId: "acct_fallback",
        messageId: "msg_root",
        parts: [{ type: "text", text: "fallback **text**" }],
      })

      expect(result.messageId).toBe("msg_reply")
      expect(requests.map((request) => request.url)).toEqual([
        "https://open.feishu.test/open-apis/cardkit/v1/cards",
        "https://open.feishu.test/open-apis/im/v1/messages/msg_root/reply",
      ])
      expect(requests[1]?.body.msg_type).toBe("text")
      expect(JSON.parse(String(requests[1]?.body.content))).toEqual({ text: "fallback **text**" })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("falls back to plain text when the answer exceeds the card size limit", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const originalFetch = mockCardFlow(requests)

    try {
      const provider = new FeishuProvider()
      const accounts = (provider as unknown as { accounts: Map<string, unknown> }).accounts
      accounts.set("acct_large", markdownAccount())

      const oversized = "x".repeat(31 * 1024)
      await provider.replyMessage({
        accountId: "acct_large",
        messageId: "msg_root",
        parts: [{ type: "text", text: oversized }],
      })

      expect(requests.map((request) => request.url)).toEqual([
        "https://open.feishu.test/open-apis/im/v1/messages/msg_root/reply",
      ])
      expect(requests[0]?.body.msg_type).toBe("text")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("Feishu account drain", () => {
  test("closes transport, flushes debounce work, and drains chat tasks to a fixed point", async () => {
    const provider = new FeishuProvider()
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const calls: string[] = []
    const perChatQueue = new Map<string, Promise<void>>()
    const enqueue = (chatId: string, task: Promise<void>) => {
      perChatQueue.set(chatId, task)
      void task.finally(() => {
        if (perChatQueue.get(chatId) === task) perChatQueue.delete(chatId)
      })
    }
    const firstTask = first.promise.then(() => {
      calls.push("first")
      enqueue(
        "chat_second",
        second.promise.then(() => {
          calls.push("second")
        }),
      )
    })
    const accounts = (
      provider as unknown as {
        accounts: Map<
          string,
          {
            runtime: {
              acceptingInbound: boolean
              inboundTasks: Set<Promise<void>>
              perChatQueue: Map<string, Promise<void>>
              debouncer: { flush(): Promise<void> }
              wsClient: { close(): void }
              drain?: Promise<void>
            }
          }
        >
      }
    ).accounts
    accounts.set("acct_drain", {
      runtime: {
        acceptingInbound: true,
        inboundTasks: new Set(),
        perChatQueue,
        debouncer: {
          async flush() {
            calls.push("flush")
            enqueue("chat_first", firstTask)
          },
        },
        wsClient: {
          close() {
            calls.push("close")
          },
        },
      },
    })

    let disconnected = false
    const disconnect = provider.disconnect({ accountId: "acct_drain" }).then(() => {
      disconnected = true
    })
    const concurrentDisconnect = provider.disconnect({ accountId: "acct_drain" })
    await Bun.sleep(0)

    expect(calls).toEqual(["close", "flush"])
    expect(disconnected).toBe(false)
    expect(accounts.has("acct_drain")).toBe(true)

    first.resolve()
    await Bun.sleep(0)
    expect(calls).toEqual(["close", "flush", "first"])
    expect(disconnected).toBe(false)

    second.resolve()
    await Promise.all([disconnect, concurrentDisconnect])
    expect(calls).toEqual(["close", "flush", "first", "second"])
    expect(accounts.has("acct_drain")).toBe(false)
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
