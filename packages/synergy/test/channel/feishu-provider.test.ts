import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { Asset } from "../../src/asset/asset"
import {
  FeishuProvider,
  enqueueFeishuConversationTask,
  filterInboundMessage,
  isSelfSender,
  isOwnBotMessage,
  normalizeBotOpenId,
  resolveSenderOpenId,
  isBotMentioned,
  resolveFeishuDebounceKey,
  resolveFeishuQueueKey,
  resolveGroupScopeKey,
} from "../../src/channel/provider/feishu"
import { createStatusReactionController } from "../../src/channel/status-reactions"
import { FeishuThreadBinding } from "../../src/channel/provider/feishu/thread-binding"
import type { StreamingSession } from "../../src/channel/types"
import { Config } from "../../src/config/config"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

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
  test("group_thread scope uses only threadId for continuity", () => {
    expect(
      resolveGroupScopeKey({
        chatId: "c1",
        senderId: "s1",
        messageId: "m1",
        rootId: "r1",
        threadId: "t1",
        scope: "group_thread",
      }),
    ).toBe("c1:thread:t1")
  })

  test("group_thread scope anchors a threadless message to its own messageId", () => {
    expect(
      resolveGroupScopeKey({
        chatId: "c1",
        senderId: "s1",
        messageId: "m1",
        rootId: "r1",
        scope: "group_thread",
      }),
    ).toBe("c1:message:m1")
  })
})

describe("Feishu thread scope isolation", () => {
  test("uses the resolved Session key for queueing and debouncing", () => {
    const firstScope = "chat_1:message:message_1"
    const secondScope = "chat_1:message:message_2"

    expect(resolveFeishuQueueKey({ chatId: "chat_1", scopeKey: firstScope, scope: "group_thread" })).toBe(firstScope)
    expect(resolveFeishuQueueKey({ chatId: "chat_1", scopeKey: secondScope, scope: "group_thread" })).toBe(secondScope)
    expect(
      resolveFeishuDebounceKey({ chatId: "chat_1", senderId: "sender_1", scopeKey: firstScope, scope: "group_thread" }),
    ).toBe(firstScope)
    expect(
      resolveFeishuDebounceKey({
        chatId: "chat_1",
        senderId: "sender_1",
        scopeKey: secondScope,
        scope: "group_thread",
      }),
    ).toBe(secondScope)
  })

  test("preserves legacy queue and debounce keys for existing scopes", () => {
    expect(resolveFeishuQueueKey({ chatId: "chat_1", scopeKey: "ignored", scope: "group_topic" })).toBe("chat_1")
    expect(
      resolveFeishuDebounceKey({
        chatId: "chat_1",
        senderId: "sender_1",
        scopeKey: "ignored",
        scope: "group_topic_sender",
      }),
    ).toBe("chat_1:sender_1")
  })
})

describe("Feishu thread bindings", () => {
  test("persist the original Session scope across provider instances", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await FeishuThreadBinding.set({
          accountId: "acct_test",
          chatId: "chat_1",
          threadId: "thread_1",
          scopeKey: "chat_1:message:message_1",
        })

        expect(await FeishuThreadBinding.get({ accountId: "acct_test", chatId: "chat_1", threadId: "thread_1" })).toBe(
          "chat_1:message:message_1",
        )
        expect(
          await FeishuThreadBinding.get({ accountId: "acct_test", chatId: "chat_1", threadId: "thread_other" }),
        ).toBeUndefined()
      },
    })
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

  test("does not force threaded replies for DMs when group_thread is enabled", async () => {
    const originalFetch = globalThis.fetch
    let requestBody: Record<string, unknown> = {}
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ code: 0, data: { message_id: "msg_reply" } }), {
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    try {
      const provider = new FeishuProvider()
      const accounts = (provider as unknown as { accounts: Map<string, unknown> }).accounts
      accounts.set("acct_dm", {
        config: accountConfig({ groupSessionScope: "group_thread", responseFormat: "text" }),
        channelConfig: {},
        apiBase: "https://open.feishu.test/open-apis",
        tokenCache: { token: "token_test", expiresAt: Date.now() + 120_000 },
      })

      await provider.replyMessage({
        accountId: "acct_dm",
        messageId: "message_dm",
        chatId: "chat_dm",
        chatType: "dm",
        parts: [{ type: "text", text: "Direct answer" }],
      })

      expect(requestBody).not.toHaveProperty("reply_in_thread")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("threads response and question cards when group_thread is enabled", async () => {
    const originalFetch = globalThis.fetch
    const replyBodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (url.endsWith("/cardkit/v1/cards")) {
        return new Response(JSON.stringify({ code: 0, data: { card_id: "card_thread" } }), {
          headers: { "Content-Type": "application/json" },
        })
      }
      replyBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ code: 0, data: { message_id: "msg_card" } }), {
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    try {
      const provider = new FeishuProvider()
      const accounts = (provider as unknown as { accounts: Map<string, unknown> }).accounts
      accounts.set("acct_thread_cards", {
        config: accountConfig({ groupSessionScope: "group_thread", replyInThread: false }),
        channelConfig: {},
        apiBase: "https://open.feishu.test/open-apis",
        tokenCache: { token: "token_test", expiresAt: Date.now() + 120_000 },
      })

      await provider.sendResponseCard({
        accountId: "acct_thread_cards",
        chatId: "chat_1",
        chatType: "group",
        replyToMessageId: "message_origin",
        requestId: "response_1",
        card: { title: "Choose", elements: [{ type: "button", id: "confirm", label: "Confirm", value: "yes" }] },
      })
      await provider.sendQuestionCard({
        accountId: "acct_thread_cards",
        chatId: "chat_1",
        chatType: "group",
        replyToMessageId: "message_origin",
        requestId: "question_1",
        questions: [
          {
            question: "Continue?",
            header: "Continue",
            options: [
              { label: "Yes", description: "Continue" },
              { label: "No", description: "Stop" },
            ],
          },
        ],
      })

      expect(replyBodies).toHaveLength(2)
      expect(replyBodies.every((body) => body.reply_in_thread === true)).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("binds a newly created Feishu thread to the originating Session scope", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const originalFetch = globalThis.fetch
        globalThis.fetch = (async () =>
          new Response(JSON.stringify({ code: 0, data: { message_id: "msg_reply", thread_id: "thread_created" } }), {
            headers: { "Content-Type": "application/json" },
          })) as unknown as typeof fetch

        try {
          const provider = new FeishuProvider()
          const accounts = (provider as unknown as { accounts: Map<string, unknown> }).accounts
          accounts.set("acct_thread", {
            config: accountConfig({ groupSessionScope: "group_thread", responseFormat: "text" }),
            channelConfig: {},
            apiBase: "https://open.feishu.test/open-apis",
            tokenCache: { token: "token_test", expiresAt: Date.now() + 120_000 },
          })

          const result = await provider.replyMessage({
            accountId: "acct_thread",
            messageId: "message_origin",
            chatId: "chat_1",
            chatType: "group",
            scopeKey: "chat_1:message:message_origin",
            parts: [{ type: "text", text: "Threaded answer" }],
          })

          expect(result.threadId).toBe("thread_created")
          expect(
            await FeishuThreadBinding.get({ accountId: "acct_thread", chatId: "chat_1", threadId: "thread_created" }),
          ).toBe("chat_1:message:message_origin")
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test("binds threads created by response and question cards", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const originalFetch = globalThis.fetch
        const threadIds = ["thread_response", "thread_question"]
        globalThis.fetch = (async (input) => {
          if (String(input).endsWith("/cardkit/v1/cards")) {
            return new Response(JSON.stringify({ code: 0, data: { card_id: "card_thread" } }), {
              headers: { "Content-Type": "application/json" },
            })
          }
          return new Response(
            JSON.stringify({ code: 0, data: { message_id: "msg_card", thread_id: threadIds.shift() } }),
            { headers: { "Content-Type": "application/json" } },
          )
        }) as typeof fetch

        try {
          const provider = new FeishuProvider()
          const accounts = (provider as unknown as { accounts: Map<string, unknown> }).accounts
          accounts.set("acct_thread_cards", {
            config: accountConfig({ groupSessionScope: "group_thread" }),
            channelConfig: {},
            apiBase: "https://open.feishu.test/open-apis",
            tokenCache: { token: "token_test", expiresAt: Date.now() + 120_000 },
          })

          await provider.sendResponseCard({
            accountId: "acct_thread_cards",
            chatId: "chat_1",
            chatType: "group",
            scopeKey: "chat_1:message:message_origin",
            replyToMessageId: "message_origin",
            requestId: "response_1",
            card: { title: "Choose", elements: [{ type: "button", id: "yes", label: "Yes", value: "yes" }] },
          })
          await provider.sendQuestionCard({
            accountId: "acct_thread_cards",
            chatId: "chat_1",
            chatType: "group",
            scopeKey: "chat_1:message:message_origin",
            replyToMessageId: "message_origin",
            requestId: "question_1",
            questions: [
              {
                question: "Continue?",
                header: "Continue",
                options: [{ label: "Yes", description: "Continue" }],
              },
            ],
          })

          expect(
            await FeishuThreadBinding.get({
              accountId: "acct_thread_cards",
              chatId: "chat_1",
              threadId: "thread_response",
            }),
          ).toBe("chat_1:message:message_origin")
          expect(
            await FeishuThreadBinding.get({
              accountId: "acct_thread_cards",
              chatId: "chat_1",
              threadId: "thread_question",
            }),
          ).toBe("chat_1:message:message_origin")
        } finally {
          globalThis.fetch = originalFetch
        }
      },
    })
  })

  test("sends an inline PNG preview before the original SVG attachment", async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; body: unknown; signal?: AbortSignal | null }> = []
    let assetPath: string | undefined
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      requests.push({ url, body: init?.body, signal: init?.signal })
      if (url.endsWith("/im/v1/images")) {
        return new Response(JSON.stringify({ code: 0, data: { image_key: "image_svg_preview" } }), {
          headers: { "Content-Type": "application/json" },
        })
      }
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
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"></svg>')
      const assetID = await Asset.write(svg, "image/svg+xml", "meme.svg")
      assetPath = Asset.resolvePath(assetID)
      const provider = new FeishuProvider()
      const accounts = (provider as unknown as { accounts: Map<string, unknown> }).accounts
      accounts.set("acct_test", {
        config: accountConfig(),
        channelConfig: {},
        apiBase: "https://open.feishu.test/open-apis",
        tokenCache: { token: "token_test", expiresAt: Date.now() + 120_000 },
      })

      await provider.replyMessage({
        accountId: "acct_test",
        messageId: "msg_topic_root",
        parts: [{ type: "file", path: assetPath, filename: "meme.svg", contentType: "image/svg+xml" }],
      })

      expect(requests.map((request) => request.url)).toEqual([
        "https://open.feishu.test/open-apis/im/v1/images",
        "https://open.feishu.test/open-apis/im/v1/messages/msg_topic_root/reply",
        "https://open.feishu.test/open-apis/im/v1/files",
        "https://open.feishu.test/open-apis/im/v1/messages/msg_topic_root/reply",
      ])
      expect(requests.every((request) => request.signal instanceof AbortSignal)).toBe(true)

      const imageUpload = requests[0]?.body
      expect(imageUpload).toBeInstanceOf(FormData)
      const preview = (imageUpload as FormData).get("image")
      expect(preview).toBeInstanceOf(File)
      expect((preview as File).type).toBe("image/png")
      expect(Buffer.from(await (preview as File).arrayBuffer()).subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      )

      const imageReply = JSON.parse(String(requests[1]?.body)) as Record<string, unknown>
      expect(imageReply).toMatchObject({
        msg_type: "image",
        content: JSON.stringify({ image_key: "image_svg_preview" }),
      })

      const fileUpload = requests[2]?.body
      expect(fileUpload).toBeInstanceOf(FormData)
      expect((fileUpload as FormData).get("file_type")).toBe("stream")
      expect((fileUpload as FormData).get("file_name")).toBe("meme.svg")
      const original = (fileUpload as FormData).get("file")
      expect(original).toBeInstanceOf(File)
      expect(Buffer.from(await (original as File).arrayBuffer())).toEqual(svg)

      const fileReply = JSON.parse(String(requests[3]?.body)) as Record<string, unknown>
      expect(fileReply).toMatchObject({
        msg_type: "file",
        content: JSON.stringify({ file_key: "file_svg" }),
      })
    } finally {
      globalThis.fetch = originalFetch
      if (assetPath) await fs.rm(assetPath, { force: true })
    }
  })

  test("falls back to the original SVG file when preview upload fails", async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; body: unknown }> = []
    let assetPath: string | undefined
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      requests.push({ url, body: init?.body })
      if (url.endsWith("/im/v1/images")) {
        return new Response(JSON.stringify({ code: 234011, msg: "unsupported image format" }), {
          headers: { "Content-Type": "application/json" },
        })
      }
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
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"></svg>')
      const assetID = await Asset.write(svg, "image/svg+xml", "meme.svg")
      assetPath = Asset.resolvePath(assetID)
      const provider = new FeishuProvider()
      const accounts = (provider as unknown as { accounts: Map<string, unknown> }).accounts
      accounts.set("acct_test", {
        config: accountConfig(),
        channelConfig: {},
        apiBase: "https://open.feishu.test/open-apis",
        tokenCache: { token: "token_test", expiresAt: Date.now() + 120_000 },
      })

      await provider.replyMessage({
        accountId: "acct_test",
        messageId: "msg_topic_root",
        parts: [{ type: "file", path: assetPath, filename: "meme.svg", contentType: "image/svg+xml" }],
      })

      expect(requests.map((request) => request.url)).toEqual([
        "https://open.feishu.test/open-apis/im/v1/images",
        "https://open.feishu.test/open-apis/im/v1/files",
        "https://open.feishu.test/open-apis/im/v1/messages/msg_topic_root/reply",
      ])
      const fileUpload = requests[1]?.body
      expect(fileUpload).toBeInstanceOf(FormData)
      const original = (fileUpload as FormData).get("file")
      expect(original).toBeInstanceOf(File)
      expect(Buffer.from(await (original as File).arrayBuffer())).toEqual(svg)
      expect(JSON.parse(String(requests[2]?.body))).toMatchObject({
        msg_type: "file",
        content: JSON.stringify({ file_key: "file_svg" }),
      })
    } finally {
      globalThis.fetch = originalFetch
      if (assetPath) await fs.rm(assetPath, { force: true })
    }
  })

  test("falls back to the original SVG file when preview delivery fails", async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; body: unknown }> = []
    let assetPath: string | undefined
    let replyCount = 0
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      requests.push({ url, body: init?.body })
      if (url.endsWith("/im/v1/images")) {
        return new Response(JSON.stringify({ code: 0, data: { image_key: "image_svg_preview" } }), {
          headers: { "Content-Type": "application/json" },
        })
      }
      if (url.endsWith("/im/v1/files")) {
        return new Response(JSON.stringify({ code: 0, data: { file_key: "file_svg" } }), {
          headers: { "Content-Type": "application/json" },
        })
      }
      replyCount += 1
      return new Response(
        JSON.stringify(
          replyCount === 1
            ? { code: 230099, msg: "preview delivery failed" }
            : { code: 0, data: { message_id: "msg_file" } },
        ),
        { headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    try {
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"></svg>')
      const assetID = await Asset.write(svg, "image/svg+xml", "meme.svg")
      assetPath = Asset.resolvePath(assetID)
      const provider = new FeishuProvider()
      const accounts = (provider as unknown as { accounts: Map<string, unknown> }).accounts
      accounts.set("acct_test", {
        config: accountConfig(),
        channelConfig: {},
        apiBase: "https://open.feishu.test/open-apis",
        tokenCache: { token: "token_test", expiresAt: Date.now() + 120_000 },
      })

      const result = await provider.replyMessage({
        accountId: "acct_test",
        messageId: "msg_topic_root",
        parts: [{ type: "file", path: assetPath, filename: "meme.svg", contentType: "image/svg+xml" }],
      })

      expect(result.messageId).toBe("msg_file")
      expect(requests.map((request) => request.url)).toEqual([
        "https://open.feishu.test/open-apis/im/v1/images",
        "https://open.feishu.test/open-apis/im/v1/messages/msg_topic_root/reply",
        "https://open.feishu.test/open-apis/im/v1/files",
        "https://open.feishu.test/open-apis/im/v1/messages/msg_topic_root/reply",
      ])
      expect(JSON.parse(String(requests[3]?.body))).toMatchObject({
        msg_type: "file",
        content: JSON.stringify({ file_key: "file_svg" }),
      })
    } finally {
      globalThis.fetch = originalFetch
      if (assetPath) await fs.rm(assetPath, { force: true })
    }
  })

  test("falls back to the original SVG file when preview rasterization fails", async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; body: unknown }> = []
    let assetPath: string | undefined
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
      const assetID = await Asset.write(Buffer.from("not an svg"), "image/svg+xml", "broken.svg")
      assetPath = Asset.resolvePath(assetID)
      const provider = new FeishuProvider()
      const accounts = (provider as unknown as { accounts: Map<string, unknown> }).accounts
      accounts.set("acct_test", {
        config: accountConfig(),
        channelConfig: {},
        apiBase: "https://open.feishu.test/open-apis",
        tokenCache: { token: "token_test", expiresAt: Date.now() + 120_000 },
      })

      await provider.replyMessage({
        accountId: "acct_test",
        messageId: "msg_topic_root",
        parts: [{ type: "file", path: assetPath, filename: "broken.svg", contentType: "image/svg+xml" }],
      })

      expect(requests.map((request) => request.url)).toEqual([
        "https://open.feishu.test/open-apis/im/v1/files",
        "https://open.feishu.test/open-apis/im/v1/messages/msg_topic_root/reply",
      ])
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
        parts: [
          {
            type: "text",
            text: "**bold** answer with `code` — see https://example.com/docs and [linked](https://example.com/ref)",
          },
        ],
      })

      expect(requests.map((request) => request.url)).toEqual([
        "https://open.feishu.test/open-apis/cardkit/v1/cards",
        "https://open.feishu.test/open-apis/im/v1/messages/msg_root/reply",
      ])
      const cardJson = JSON.parse(String(requests[0]?.body.data)) as {
        body: { elements: Array<{ tag: string; content: string }> }
      }
      expect(cardJson.body.elements[0]?.tag).toBe("markdown")
      expect(cardJson.body.elements[0]?.content).toBe(
        "**bold** answer with `code` — see https://example.com/docs and [linked](https://example.com/ref)",
      )
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

describe("Feishu conversation acceptance queue", () => {
  test("serializes acceptance for the same key without waiting for background execution", async () => {
    const perChatQueue = new Map<string, Promise<void>>()
    const backgroundExecutions = new Set<Promise<void>>()
    const firstAcceptance = Promise.withResolvers<void>()
    const firstExecution = Promise.withResolvers<void>()
    const calls: string[] = []

    const first = enqueueFeishuConversationTask({
      key: "thread_a",
      perChatQueue,
      backgroundExecutions,
      task: async () => {
        calls.push("first:start")
        await firstAcceptance.promise
        calls.push("first:accepted")
        return { accepted: true, execution: firstExecution.promise }
      },
    })
    const second = enqueueFeishuConversationTask({
      key: "thread_a",
      perChatQueue,
      backgroundExecutions,
      task: async () => {
        calls.push("second:accepted")
        return { accepted: true, execution: Promise.resolve() }
      },
    })

    await Bun.sleep(0)
    expect(calls).toEqual(["first:start"])
    firstAcceptance.resolve()
    await Promise.all([first, second])
    expect(calls).toEqual(["first:start", "first:accepted", "second:accepted"])
    expect(backgroundExecutions.size).toBe(1)

    firstExecution.resolve()
    await Promise.allSettled(Array.from(backgroundExecutions))
    await Bun.sleep(0)
    expect(backgroundExecutions.size).toBe(0)
  })

  test("accepts different keys independently", async () => {
    const perChatQueue = new Map<string, Promise<void>>()
    const backgroundExecutions = new Set<Promise<void>>()
    const firstAcceptance = Promise.withResolvers<void>()
    let secondAccepted = false

    const first = enqueueFeishuConversationTask({
      key: "thread_a",
      perChatQueue,
      backgroundExecutions,
      task: async () => {
        await firstAcceptance.promise
        return { accepted: true, execution: Promise.resolve() }
      },
    })
    const second = enqueueFeishuConversationTask({
      key: "thread_b",
      perChatQueue,
      backgroundExecutions,
      task: async () => {
        secondAccepted = true
        return { accepted: true, execution: Promise.resolve() }
      },
    })

    await second
    expect(secondAccepted).toBe(true)
    expect(perChatQueue.has("thread_a")).toBe(true)
    firstAcceptance.resolve()
    await first
  })

  test("observes acceptance and execution failures through their owning callbacks", async () => {
    const perChatQueue = new Map<string, Promise<void>>()
    const backgroundExecutions = new Set<Promise<void>>()
    const acceptanceFailure = new Error("acceptance failed")
    const executionFailure = new Error("execution failed")
    const acceptanceErrors: unknown[] = []
    const executionErrors: unknown[] = []

    await enqueueFeishuConversationTask({
      key: "thread_acceptance_failure",
      perChatQueue,
      backgroundExecutions,
      task: async () => {
        throw acceptanceFailure
      },
      onAcceptanceError: (error) => acceptanceErrors.push(error),
    })
    await enqueueFeishuConversationTask({
      key: "thread_execution_failure",
      perChatQueue,
      backgroundExecutions,
      task: async () => ({ accepted: true, execution: Promise.reject(executionFailure) }),
      onExecutionError: (error) => executionErrors.push(error),
    })
    await Promise.allSettled(Array.from(backgroundExecutions))

    expect(acceptanceErrors).toEqual([acceptanceFailure])
    expect(executionErrors).toEqual([executionFailure])
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
              backgroundExecutions: Set<Promise<void>>
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
        backgroundExecutions: new Set(),
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
    expect(render?.([{ id: "1", tool: "webfetch", status: "running" }])).toContain("**Tools · Working**")
    expect(render?.([{ id: "1", tool: "webfetch", status: "completed" }])).toContain("**Tools · Completed**")
    expect(render?.([{ id: "1", tool: "webfetch", status: "error" }])).toContain("**Tools · Completed with errors**")
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
