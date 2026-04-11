import { afterEach, describe, expect, mock, test } from "bun:test"
import { FeishuProvider } from "../../src/channel/provider/feishu"
import { mergeStreamingText } from "../../src/channel/provider/feishu/streaming-card"
import { createStatusReactionController } from "../../src/channel/status-reactions"
import type { StreamingSession } from "../../src/channel/types"
import type { Config } from "../../src/config/config"

describe("FeishuProvider inbound filtering", () => {
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

  test("buildMessageContext ignores self-sent bot/app messages", async () => {
    const provider = new FeishuProvider()
    const ctx = await (provider as any).buildMessageContext(
      "acct",
      accountConfig(),
      { type: "feishu", accounts: {}, streaming: true } as Config.ChannelFeishu,
      {
        event: {
          message: {
            chat_id: "chat_1",
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({ text: "hello from bot" }),
            message_id: "msg_bot_1",
          },
          sender: {
            sender_id: { open_id: "ou_bot" },
            sender_type: "app",
          },
        },
      },
    )

    expect(ctx).toBeNull()
  })

  test("buildMessageContext keeps normal user messages", async () => {
    const provider = new FeishuProvider()
    const ctx = await (provider as any).buildMessageContext(
      "acct",
      accountConfig(),
      { type: "feishu", accounts: {}, streaming: true } as Config.ChannelFeishu,
      {
        event: {
          message: {
            chat_id: "chat_1",
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({ text: "hello" }),
            message_id: "msg_user_1",
            create_time: "1234567890",
          },
          sender: {
            sender_id: { open_id: "ou_user", user_id: "user_1" },
            sender_type: "user",
          },
        },
      },
    )

    expect(ctx).toMatchObject({
      channelType: "feishu",
      accountId: "acct",
      chatId: "chat_1",
      chatType: "dm",
      senderId: "ou_user",
      senderName: "user_1",
      text: "hello",
      messageId: "msg_user_1",
      timestamp: 1234567890,
    })
  })

  test("group messages mentioning other users do not count as bot mentions", async () => {
    const provider = new FeishuProvider()
    ;(provider as any).accounts.set("acct", {
      config: accountConfig({ requireMention: true, botOpenId: "ou_bot" }),
      channelConfig: { type: "feishu", accounts: {}, streaming: true },
      apiBase: "https://open.feishu.cn/open-apis",
      tokenCache: null,
      botOpenId: "ou_bot",
      missingBotOpenIdWarned: false,
    })

    const ctx = await (provider as any).buildMessageContext(
      "acct",
      accountConfig({ requireMention: true, botOpenId: "ou_bot" }),
      { type: "feishu", accounts: {}, streaming: true } as Config.ChannelFeishu,
      {
        event: {
          message: {
            chat_id: "chat_group_1",
            chat_type: "group",
            message_type: "text",
            content: JSON.stringify({ text: "@_user_1 ping" }),
            message_id: "msg_group_1",
            mentions: [{ key: "@_user_1", id: { open_id: "ou_other" }, name: "Other User" }],
          },
          sender: {
            sender_id: { open_id: "ou_user", user_id: "user_1" },
            sender_type: "user",
          },
        },
      },
    )

    expect(ctx).toBeNull()
  })

  test("group messages mentioning the configured bot pass mention filtering", async () => {
    const provider = new FeishuProvider()
    ;(provider as any).accounts.set("acct", {
      config: accountConfig({ requireMention: true, botOpenId: "ou_bot" }),
      channelConfig: { type: "feishu", accounts: {}, streaming: true },
      apiBase: "https://open.feishu.cn/open-apis",
      tokenCache: null,
      botOpenId: "ou_bot",
      missingBotOpenIdWarned: false,
    })

    const ctx = await (provider as any).buildMessageContext(
      "acct",
      accountConfig({ requireMention: true, botOpenId: "ou_bot" }),
      { type: "feishu", accounts: {}, streaming: true } as Config.ChannelFeishu,
      {
        event: {
          message: {
            chat_id: "chat_group_1",
            chat_type: "group",
            message_type: "text",
            content: JSON.stringify({ text: "@_user_1 hello" }),
            message_id: "msg_group_2",
            mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Synergy" }],
          },
          sender: {
            sender_id: { open_id: "ou_user", user_id: "user_1" },
            sender_type: "user",
          },
        },
      },
    )

    expect(ctx).toMatchObject({
      chatType: "group",
      wasMentioned: true,
      text: "@Synergy hello",
    })
  })

  test("group mention filtering auto-resolves bot open id via bot info API", async () => {
    const provider = new FeishuProvider()
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = url.toString()
      if (urlStr.endsWith("/bot/v3/info")) {
        return new Response(JSON.stringify({ code: 0, bot: { open_id: "ou_bot" } }), { status: 200 })
      }
      throw new Error(`Unexpected fetch: ${urlStr}`)
    }) as unknown as typeof fetch

    try {
      ;(provider as any).accounts.set("acct", {
        config: accountConfig({ requireMention: true }),
        channelConfig: { type: "feishu", accounts: {}, streaming: true },
        apiBase: "https://open.feishu.cn/open-apis",
        tokenCache: { token: "token", expiresAt: Date.now() + 3600_000 },
        missingBotOpenIdWarned: false,
      })

      const ctx = await (provider as any).buildMessageContext(
        "acct",
        accountConfig({ requireMention: true }),
        { type: "feishu", accounts: {}, streaming: true } as Config.ChannelFeishu,
        {
          event: {
            message: {
              chat_id: "chat_group_1",
              chat_type: "group",
              message_type: "text",
              content: JSON.stringify({ text: "@_user_1 hello" }),
              message_id: "msg_group_3",
              mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Synergy" }],
            },
            sender: {
              sender_id: { open_id: "ou_user", user_id: "user_1" },
              sender_type: "user",
            },
          },
        },
      )

      expect(ctx).toMatchObject({
        chatType: "group",
        wasMentioned: true,
      })
      expect((provider as any).accounts.get("acct")?.botOpenId).toBe("ou_bot")
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

describe("Feishu streaming card rendering", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("updates status, answer, and tool sections independently", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString()
      requests.push({ url: urlStr, init })

      if (urlStr.endsWith("/cardkit/v1/cards")) {
        return new Response(JSON.stringify({ code: 0, data: { card_id: "card_1" } }), { status: 200 })
      }
      if (urlStr.includes("/im/v1/messages/msg_1/reply")) {
        return new Response(JSON.stringify({ code: 0, data: { message_id: "reply_1" } }), { status: 200 })
      }
      if (urlStr.includes("/cardkit/v1/cards/card_1/elements/")) {
        return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
      }
      if (urlStr.endsWith("/cardkit/v1/cards/card_1/settings")) {
        return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })
      }

      throw new Error(`Unexpected fetch: ${urlStr}`)
    }) as unknown as typeof fetch

    const provider = new FeishuProvider()
    ;(provider as any).accounts.set("acct", {
      config: {
        enabled: true,
        appId: "app",
        appSecret: "secret",
        allowDM: true,
        allowGroup: true,
        requireMention: true,
        streaming: true,
        streamingThrottleMs: 0,
        groupSessionScope: "group",
        inboundDebounceMs: 0,
        resolveSenderNames: true,
        replyInThread: false,
      } satisfies Config.ChannelFeishuAccount,
      channelConfig: { type: "feishu", accounts: {}, streaming: true } satisfies Partial<Config.ChannelFeishu>,
      apiBase: "https://open.feishu.cn/open-apis",
      tokenCache: { token: "token", expiresAt: Date.now() + 3600_000 },
    })

    const session = provider.createStreamingSession({
      accountId: "acct",
      chatId: "chat_1",
      replyToMessageId: "msg_1",
    })

    await session.start()
    await session.update("你好，先给你一个稳定结论。")
    await session.update("你好，先给你一个稳定结论。\n\n我正在整理方案。")
    await session.updateToolProgress([
      { id: "t1", tool: "read", title: "定位实现", status: "completed" },
      { id: "t2", tool: "webfetch", title: "查官方文档", status: "running" },
    ])
    await session.close("你好，先给你一个稳定结论。\n\n我正在整理方案。\n\n已经整理好方案。")

    const elementUpdates = requests.filter((request) => request.url.includes("/elements/"))
    expect(elementUpdates.map((request) => request.url)).toEqual([
      "https://open.feishu.cn/open-apis/cardkit/v1/cards/card_1/elements/status_content/content",
      "https://open.feishu.cn/open-apis/cardkit/v1/cards/card_1/elements/answer_content/content",
      "https://open.feishu.cn/open-apis/cardkit/v1/cards/card_1/elements/answer_content/content",
      "https://open.feishu.cn/open-apis/cardkit/v1/cards/card_1/elements/status_content/content",
      "https://open.feishu.cn/open-apis/cardkit/v1/cards/card_1/elements/tool_content/content",
      "https://open.feishu.cn/open-apis/cardkit/v1/cards/card_1/elements/status_content/content",
      "https://open.feishu.cn/open-apis/cardkit/v1/cards/card_1/elements/answer_content/content",
    ])

    const toolUpdateBody = JSON.parse(String(elementUpdates[4].init?.body))
    expect(toolUpdateBody.content).toContain("**Tools · Working**")
    expect(toolUpdateBody.content).toContain("- ✅ read · 定位实现")
    expect(toolUpdateBody.content).toContain("- ⌨️ webfetch · 查官方文档")
    expect(toolUpdateBody.content).toContain("1/2 completed")

    const finalAnswerBody = JSON.parse(String(elementUpdates[6].init?.body))
    expect(finalAnswerBody.content).toContain("你好，先给你一个稳定结论。")
    expect(finalAnswerBody.content).toContain("我正在整理方案。")
    expect(finalAnswerBody.content).toContain("已经整理好方案。")

    const settingsRequest = requests.find((request) => request.url.endsWith("/cardkit/v1/cards/card_1/settings"))
    expect(settingsRequest).toBeDefined()
    expect(JSON.parse(String(settingsRequest?.init?.body)).settings).toContain('"streaming_mode":false')
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

describe("FeishuProvider outbound media", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function providerWithAccount() {
    const provider = new FeishuProvider()
    ;(provider as any).accounts.set("acct", {
      config: {
        enabled: true,
        appId: "app",
        appSecret: "secret",
        allowDM: true,
        allowGroup: true,
        requireMention: true,
        streaming: true,
        streamingThrottleMs: 100,
        groupSessionScope: "group",
        inboundDebounceMs: 0,
        resolveSenderNames: true,
        replyInThread: false,
      } satisfies Config.ChannelFeishuAccount,
      channelConfig: { type: "feishu", accounts: {}, streaming: true } satisfies Partial<Config.ChannelFeishu>,
      apiBase: "https://open.feishu.cn/open-apis",
      tokenCache: { token: "token", expiresAt: Date.now() + 3600_000 },
    })
    return provider
  }

  test("addReaction returns reaction id and removeReaction deletes it", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString()
      requests.push({ url: urlStr, init })
      if (urlStr.endsWith("/im/v1/messages/msg_1/reactions")) {
        return new Response(JSON.stringify({ code: 0, data: { reaction_id: "reaction_1" } }), { status: 200 })
      }
      if (urlStr.endsWith("/im/v1/messages/msg_1/reactions/reaction_1")) {
        return new Response(JSON.stringify({ code: 0, msg: "success" }), { status: 200 })
      }
      throw new Error(`Unexpected fetch: ${urlStr}`)
    }) as unknown as typeof fetch

    const provider = providerWithAccount()
    const reaction = await provider.addReaction({ accountId: "acct", messageId: "msg_1", emoji: "Typing" })
    await provider.removeReaction?.({ accountId: "acct", messageId: "msg_1", reactionId: "reaction_1" })

    expect(reaction).toEqual({ reactionId: "reaction_1" })
    expect(requests[0].url).toContain("/im/v1/messages/msg_1/reactions")
    expect(requests[0].init?.method).toBe("POST")
    expect(requests[1].url).toContain("/im/v1/messages/msg_1/reactions/reaction_1")
    expect(requests[1].init?.method).toBe("DELETE")
  })

  test("replyMessage uploads image then replies with image payload", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString()
      requests.push({ url: urlStr, init })
      if (urlStr.endsWith("/im/v1/images")) {
        return new Response(JSON.stringify({ code: 0, data: { image_key: "img_v2_123" } }), { status: 200 })
      }
      if (urlStr.includes("/im/v1/messages/msg_1/reply")) {
        return new Response(JSON.stringify({ code: 0, data: { message_id: "reply_1" } }), { status: 200 })
      }
      throw new Error(`Unexpected fetch: ${urlStr}`)
    }) as unknown as typeof fetch

    const filePath = "/tmp/synergy-feishu-test-image.png"
    await Bun.write(filePath, new Uint8Array([1, 2, 3]))

    const provider = providerWithAccount()
    const result = await provider.replyMessage({
      accountId: "acct",
      messageId: "msg_1",
      parts: [{ type: "image", path: filePath, filename: "image.png", contentType: "image/png" }],
    })

    expect(result).toEqual({ messageId: "reply_1" })
    expect(requests[0].url).toContain("/im/v1/images")
    expect(requests[1].url).toContain("/im/v1/messages/msg_1/reply")
    expect(JSON.parse(String(requests[1].init?.body))).toEqual({
      content: JSON.stringify({ image_key: "img_v2_123" }),
      msg_type: "image",
    })
  })

  test("pushMessage sends text and file parts in order", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString()
      requests.push({ url: urlStr, init })
      if (urlStr.endsWith("/im/v1/files")) {
        return new Response(JSON.stringify({ code: 0, data: { file_key: "file_v2_123" } }), { status: 200 })
      }
      if (urlStr.includes("/im/v1/messages?receive_id_type=chat_id")) {
        return new Response(JSON.stringify({ code: 0, data: { message_id: `msg_${requests.length}` } }), {
          status: 200,
        })
      }
      throw new Error(`Unexpected fetch: ${urlStr}`)
    }) as unknown as typeof fetch

    const filePath = "/tmp/synergy-feishu-test-report.pdf"
    await Bun.write(filePath, new Uint8Array([4, 5, 6]))

    const provider = providerWithAccount()
    const result = await provider.pushMessage({
      accountId: "acct",
      chatId: "chat_1",
      parts: [
        { type: "text", text: "Here is the report." },
        { type: "file", path: filePath, filename: "report.pdf", contentType: "application/pdf" },
      ],
    })

    expect(result).toEqual({ messageId: "msg_3" })
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      receive_id: "chat_1",
      content: JSON.stringify({ text: "Here is the report." }),
      msg_type: "text",
    })
    expect(requests[1].url).toContain("/im/v1/files")
    expect(JSON.parse(String(requests[2].init?.body))).toEqual({
      receive_id: "chat_1",
      content: JSON.stringify({ file_key: "file_v2_123" }),
      msg_type: "file",
    })
  })

  test("video without duration degrades to file message", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString()
      requests.push({ url: urlStr, init })
      if (urlStr.endsWith("/im/v1/files")) {
        return new Response(JSON.stringify({ code: 0, data: { file_key: "file_v2_video" } }), { status: 200 })
      }
      if (urlStr.includes("/im/v1/messages/msg_2/reply")) {
        return new Response(JSON.stringify({ code: 0, data: { message_id: "reply_video" } }), { status: 200 })
      }
      throw new Error(`Unexpected fetch: ${urlStr}`)
    }) as unknown as typeof fetch

    const filePath = "/tmp/synergy-feishu-test-video.mp4"
    await Bun.write(filePath, new Uint8Array([7, 8, 9]))

    const provider = providerWithAccount()
    const result = await provider.replyMessage({
      accountId: "acct",
      messageId: "msg_2",
      parts: [{ type: "video", path: filePath, filename: "clip.mp4", contentType: "video/mp4" }],
    })

    expect(result).toEqual({ messageId: "reply_video" })
    expect(JSON.parse(String(requests[1].init?.body))).toEqual({
      content: JSON.stringify({ file_key: "file_v2_video" }),
      msg_type: "file",
    })
  })
})
