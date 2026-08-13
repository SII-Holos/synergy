import { describe, expect, test } from "bun:test"
import {
  FeishuProvider,
  parseFeishuResponseCardAction,
  renderFeishuResponseCard,
  routeFeishuCardAction,
} from "../../src/channel/provider/feishu"
import type { ResponseCard } from "../../src/channel/types"
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

const card: ResponseCard = {
  title: "Deploy release",
  elements: [
    {
      type: "text",
      format: "markdown",
      text: "Review [runbook](https://evil.test/runbook) <script>alert(1)</script>",
    },
    { type: "button", id: "deploy", label: "Deploy", value: "bash -c 'curl evil.test'", style: "primary" },
    {
      type: "select",
      id: "environment",
      label: "Environment",
      placeholder: "Choose environment",
      options: [
        { label: "Staging", value: "staging" },
        { label: "Production", value: "production" },
      ],
    },
  ],
}

function buttonCallback() {
  return {
    token: "callback_token_1",
    context: { open_message_id: "om_card", open_chat_id: "oc_chat" },
    operator: { open_id: "ou_requester" },
    action: {
      tag: "button",
      value: {
        synergy_response_card: {
          version: 1,
          request_id: "part_response_card",
          action_id: "response_card:deploy",
          action_type: "button",
          value: "bash -c 'curl evil.test'",
        },
      },
    },
  }
}

describe("Feishu response cards", () => {
  test("renders bounded provider-native controls with namespaced callback values and sanitized markdown", () => {
    const rendered = renderFeishuResponseCard(card)
    const serialized = JSON.stringify(rendered)

    expect(rendered).toMatchObject({
      schema: "2.0",
      header: { title: { tag: "plain_text", content: "Deploy release" } },
    })
    expect(serialized).not.toContain("https://evil.test")
    expect(serialized).not.toContain("<script>")
    expect(serialized).toContain('"action_id":"response_card:deploy"')
    expect(serialized).toContain('"action_type":"button"')
    expect(serialized).toContain('"value":"bash -c \'curl evil.test\'"')
    expect(serialized).toContain('"action_id":"response_card:environment"')
    expect(serialized).toContain('"value":"production"')
  })

  test("parses only Synergy namespaced button and select callbacks", () => {
    const button = parseFeishuResponseCardAction({
      token: "callback_token_1",
      context: { open_message_id: "om_card", open_chat_id: "oc_chat" },
      operator: { open_id: "ou_requester" },
      action: {
        tag: "button",
        value: {
          synergy_response_card: {
            version: 1,
            request_id: "part_response_card",
            action_id: "response_card:deploy",
            action_type: "button",
            value: "bash -c 'curl evil.test'",
          },
        },
      },
    })
    expect(button).toEqual({
      status: "valid",
      callback: {
        eventId: expect.stringMatching(/^[a-f0-9]{64}$/),
        requestId: "part_response_card",
        messageId: "om_card",
        chatId: "oc_chat",
        requesterId: "ou_requester",
        action: { type: "button", id: "response_card:deploy", value: "bash -c 'curl evil.test'" },
      },
    })

    const select = parseFeishuResponseCardAction({
      token: "callback_token_2",
      open_message_id: "om_card",
      open_chat_id: "oc_chat",
      operator: { open_id: "ou_requester" },
      action: {
        tag: "select_static",
        option: "production",
        value: {
          synergy_response_card: {
            version: 1,
            request_id: "part_response_card",
            action_id: "response_card:environment",
            action_type: "select",
          },
        },
      },
    })
    expect(select).toMatchObject({
      status: "valid",
      callback: {
        messageId: "om_card",
        chatId: "oc_chat",
        requesterId: "ou_requester",
        action: { type: "select", id: "response_card:environment", value: "production" },
      },
    })

    expect(parseFeishuResponseCardAction({ action: { tag: "button", value: { other: true } } })).toEqual({
      status: "ignored",
    })
    expect(
      parseFeishuResponseCardAction({
        token: "callback_token_3",
        context: { open_message_id: "om_card", open_chat_id: "oc_chat" },
        operator: { open_id: "ou_requester" },
        action: {
          tag: "button",
          value: { synergy_response_card: { version: 1, action_id: "bash", action_type: "button" } },
        },
      }),
    ).toEqual({ status: "invalid" })
  })

  test("routes built-in callbacks before legacy plugin handlers with stable toasts", async () => {
    const pluginCalls: unknown[] = []
    const pluginHandler = async (data: unknown, accountId: string) => {
      pluginCalls.push({ data, accountId })
      return { legacy: true }
    }

    expect(
      await routeFeishuCardAction({
        data: buttonCallback(),
        accountId: "acct_test",
        onResponseCardAction: async () => ({ status: "accepted" }),
        pluginHandlers: [pluginHandler],
      }),
    ).toEqual({ toast: { type: "success", content: "操作已接收" } })
    expect(
      await routeFeishuCardAction({
        data: buttonCallback(),
        accountId: "acct_test",
        onResponseCardAction: async () => ({ status: "duplicate" }),
        pluginHandlers: [pluginHandler],
      }),
    ).toEqual({ toast: { type: "info", content: "操作已接收" } })
    expect(
      await routeFeishuCardAction({
        data: buttonCallback(),
        accountId: "acct_test",
        onResponseCardAction: async () => ({ status: "expired" }),
        pluginHandlers: [pluginHandler],
      }),
    ).toEqual({ toast: { type: "warning", content: "此操作已失效，请使用最新卡片重试" } })
    expect(pluginCalls).toEqual([])

    const unrelated = { action: { tag: "button", value: { plugin_action: true } } }
    expect(
      await routeFeishuCardAction({
        data: unrelated,
        accountId: "acct_test",
        pluginHandlers: [pluginHandler],
      }),
    ).toEqual({ legacy: true })
    expect(pluginCalls).toEqual([{ data: unrelated, accountId: "acct_test" }])
  })

  test("creates a CardKit card and replies with its interactive message reference", async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ url, body })
      if (url.endsWith("/cardkit/v1/cards")) {
        return new Response(JSON.stringify({ code: 0, data: { card_id: "card_123" } }), {
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_response_card" } }), {
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    try {
      const provider = new FeishuProvider()
      const accounts = (provider as unknown as { accounts: Map<string, unknown> }).accounts
      accounts.set("acct_test", {
        config: accountConfig({ replyInThread: true }),
        channelConfig: {},
        apiBase: "https://open.feishu.test/open-apis",
        tokenCache: { token: "token_test", expiresAt: Date.now() + 120_000 },
      })

      const sent = await provider.sendResponseCard?.({
        accountId: "acct_test",
        chatId: "oc_chat",
        replyToMessageId: "om_topic",
        requestId: "part_response_card",
        card,
      })

      expect(sent).toEqual({ messageId: "om_response_card", threadId: undefined })
      expect(requests.map((request) => request.url)).toEqual([
        "https://open.feishu.test/open-apis/cardkit/v1/cards",
        "https://open.feishu.test/open-apis/im/v1/messages/om_topic/reply",
      ])
      expect(requests[0]?.body).toMatchObject({ type: "card_json" })
      expect(requests[1]?.body).toMatchObject({
        msg_type: "interactive",
        reply_in_thread: true,
        content: JSON.stringify({ type: "card", data: { card_id: "card_123" } }),
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("rejects schema-valid card that renders above the safe CardKit size limit before any fetch call", async () => {
    const bigText = "x".repeat(2_000)
    const oversizedCard: ResponseCard = {
      title: "Oversized",
      elements: Array.from({ length: 20 }, (_, i) => ({
        type: "text" as const,
        format: "markdown" as const,
        text: `${bigText}[${i}]`,
      })),
    }

    const rendered = renderFeishuResponseCard(oversizedCard)
    const byteLength = new TextEncoder().encode(JSON.stringify(rendered)).length
    expect(byteLength).toBeGreaterThan(30_000)

    const originalFetch = globalThis.fetch
    const fetchCalls: unknown[] = []
    globalThis.fetch = (async (...args) => {
      fetchCalls.push(args)
      return new Response(JSON.stringify({ code: 0, data: { card_id: "card_123" } }), {
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch

    try {
      const provider = new FeishuProvider()
      const accounts = (provider as unknown as { accounts: Map<string, unknown> }).accounts
      accounts.set("acct_test", {
        config: accountConfig(),
        channelConfig: {},
        apiBase: "https://open.feishu.test/open-apis",
        tokenCache: { token: "token_test", expiresAt: Date.now() + 120_000 },
      })

      await expect(
        provider.sendResponseCard!({
          accountId: "acct_test",
          chatId: "oc_chat",
          replyToMessageId: "om_topic",
          requestId: "part_response_card",
          card: oversizedCard,
        }),
      ).rejects.toThrow(/too large|exceed|size/i)

      expect(fetchCalls).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
