import { describe, expect, test } from "bun:test"
import { FeishuStreamingCard } from "../../src/channel/provider/feishu/streaming-card"

function response(input: { status?: number; code?: number; msg?: string; data?: Record<string, unknown> } = {}) {
  return new Response(
    JSON.stringify({
      code: input.code ?? 0,
      msg: input.msg,
      data: input.data,
    }),
    { status: input.status ?? 200, headers: { "Content-Type": "application/json" } },
  )
}

describe("Feishu streaming card finalization", () => {
  test("falls back to a text reply when Feishu rejects the final answer update", async () => {
    const originalFetch = globalThis.fetch
    const fallback: string[] = []
    let finalAnswerRejected = false

    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (url.endsWith("/cardkit/v1/cards")) {
        return response({ data: { card_id: "card_test" } })
      }
      if (url.endsWith("/im/v1/messages/message_root/reply")) {
        return response({ data: { message_id: "message_card" } })
      }
      if (url.includes("/elements/answer_content/content")) {
        const body = JSON.parse(String(init?.body)) as { content?: string }
        if (body.content === "final answer") {
          finalAnswerRejected = true
          return response({ code: 230099, msg: "content rejected" })
        }
      }
      return response()
    }) as typeof fetch

    try {
      const options = {
        apiBase: "https://open.feishu.test/open-apis",
        getAccessToken: async () => "token_test",
        chatId: "chat_test",
        replyToMessageId: "message_root",
        throttleMs: 0,
        sendFallback: async (text: string) => {
          fallback.push(text)
        },
      }
      const card = new FeishuStreamingCard(options)

      await card.start()
      await card.update("progress")
      await card.close("final answer")

      expect(finalAnswerRejected).toBe(true)
      expect(fallback).toEqual(["final answer"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("retries the final answer when the matching streaming update was rejected", async () => {
    const originalFetch = globalThis.fetch
    const fallback: string[] = []
    let answerAttempts = 0

    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (url.endsWith("/cardkit/v1/cards")) {
        return response({ data: { card_id: "card_test" } })
      }
      if (url.endsWith("/im/v1/messages/message_root/reply")) {
        return response({ data: { message_id: "message_card" } })
      }
      if (url.includes("/elements/answer_content/content")) {
        const body = JSON.parse(String(init?.body)) as { content?: string }
        if (body.content === "final answer") {
          answerAttempts += 1
          return response({ code: 230099, msg: "content rejected" })
        }
      }
      return response()
    }) as typeof fetch

    try {
      const card = new FeishuStreamingCard({
        apiBase: "https://open.feishu.test/open-apis",
        getAccessToken: async () => "token_test",
        chatId: "chat_test",
        replyToMessageId: "message_root",
        throttleMs: 0,
        sendFallback: async (text) => {
          fallback.push(text)
        },
      })

      await card.start()
      await card.update("final answer").catch(() => {})
      await card.close("final answer")

      expect(answerAttempts).toBe(2)
      expect(fallback).toEqual(["final answer"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("falls back to a text reply when the final answer update returns an HTTP error", async () => {
    const originalFetch = globalThis.fetch
    const fallback: string[] = []

    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (url.endsWith("/cardkit/v1/cards")) {
        return response({ data: { card_id: "card_test" } })
      }
      if (url.endsWith("/im/v1/messages/message_root/reply")) {
        return response({ data: { message_id: "message_card" } })
      }
      if (url.includes("/elements/answer_content/content")) {
        const body = JSON.parse(String(init?.body)) as { content?: string }
        if (body.content === "final answer") {
          return response({ status: 502, code: 230099, msg: "upstream unavailable" })
        }
      }
      return response()
    }) as typeof fetch

    try {
      const card = new FeishuStreamingCard({
        apiBase: "https://open.feishu.test/open-apis",
        getAccessToken: async () => "token_test",
        chatId: "chat_test",
        replyToMessageId: "message_root",
        throttleMs: 0,
        sendFallback: async (text) => {
          fallback.push(text)
        },
      })

      await card.start()
      await card.close("final answer")

      expect(fallback).toEqual(["final answer"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("falls back to a text reply when Feishu cannot close streaming mode", async () => {
    const originalFetch = globalThis.fetch
    const fallback: string[] = []

    globalThis.fetch = (async (input) => {
      const url = String(input)
      if (url.endsWith("/cardkit/v1/cards")) {
        return response({ data: { card_id: "card_test" } })
      }
      if (url.endsWith("/im/v1/messages/message_root/reply")) {
        return response({ data: { message_id: "message_card" } })
      }
      if (url.endsWith("/cardkit/v1/cards/card_test/settings")) {
        return response({ code: 300309, msg: "streaming mode already closed" })
      }
      return response()
    }) as typeof fetch

    try {
      const card = new FeishuStreamingCard({
        apiBase: "https://open.feishu.test/open-apis",
        getAccessToken: async () => "token_test",
        chatId: "chat_test",
        replyToMessageId: "message_root",
        throttleMs: 0,
        sendFallback: async (text) => {
          fallback.push(text)
        },
      })

      await card.start()
      await card.close("final answer")

      expect(fallback).toEqual(["final answer"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
