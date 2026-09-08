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

function requestBody(init?: RequestInit) {
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

type InstallOptions = {
  imageDownloadStatus?: number
  imageDownloadContentType?: string
  imageKey?: string
}

function installFetch(options: InstallOptions = {}) {
  const originalFetch = globalThis.fetch
  const answerUpdates: string[] = []
  const requests: Array<{ url: string }> = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    requests.push({ url })
    if (url.endsWith("/cardkit/v1/cards")) {
      return response({ data: { card_id: "card_test" } })
    }
    if (url.endsWith("/im/v1/messages/message_root/reply")) {
      return response({ data: { message_id: "message_card" } })
    }
    if (url.endsWith("/elements/answer_content/content")) {
      answerUpdates.push(String(requestBody(init).content))
      return response()
    }
    if (url.endsWith("/im/v1/images")) {
      return response({ data: { image_key: options.imageKey ?? "img_v2_uploaded" } })
    }
    if (url.startsWith("https://img.example.com/")) {
      const status = options.imageDownloadStatus ?? 200
      if (status !== 200) return new Response("not found", { status })
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": options.imageDownloadContentType ?? "image/png" },
      })
    }
    return response()
  }) as typeof fetch
  return {
    answerUpdates,
    requests,
    restore() {
      globalThis.fetch = originalFetch
    },
  }
}

function createCard(sendFallback?: (text: string) => Promise<void>) {
  return new FeishuStreamingCard({
    apiBase: "https://open.feishu.test/open-apis",
    getAccessToken: async () => "token_test",
    chatId: "chat_test",
    replyToMessageId: "message_root",
    throttleMs: 0,
    sendFallback,
  })
}

describe("Feishu streaming card markdown images", () => {
  test("degrades image syntax to a link during incremental renders without network I/O", async () => {
    const fetchState = installFetch()
    try {
      const card = createCard()
      await card.start()
      await card.update("Here: ![logo](https://img.example.com/logo.png)")

      // The incremental render must be synchronous and degraded to a link,
      // with no download/upload network I/O on the streaming path.
      expect(fetchState.answerUpdates.at(-1)).toBe("Here: [logo](https://img.example.com/logo.png)")
      expect(fetchState.requests.some((request) => request.url.endsWith("/im/v1/images"))).toBe(false)
    } finally {
      fetchState.restore()
    }
  })

  test("materializes image URLs into image keys in the final answer on close", async () => {
    const fetchState = installFetch({ imageKey: "img_v2_final" })
    try {
      const card = createCard()
      await card.start()
      await card.update("![logo](https://img.example.com/logo.png)")
      await card.close()

      expect(fetchState.answerUpdates.at(-1)).toBe("![logo](img_v2_final)")
      expect(fetchState.requests.some((request) => request.url.endsWith("/im/v1/images"))).toBe(true)
    } finally {
      fetchState.restore()
    }
  })

  test("keeps degraded links and does not fall back to plain text when materialization fails", async () => {
    const fallbackCalls: string[] = []
    const fetchState = installFetch({ imageDownloadStatus: 404 })
    try {
      const card = createCard(async (text) => {
        fallbackCalls.push(text)
      })
      await card.start()
      await card.update("![logo](https://img.example.com/logo.png)")
      await card.close()

      expect(fetchState.answerUpdates.at(-1)).toBe("[logo](https://img.example.com/logo.png)")
      expect(fallbackCalls).toHaveLength(0)
    } finally {
      fetchState.restore()
    }
  })

  test("keeps code-block image examples untouched in renders and final materialization", async () => {
    const fetchState = installFetch({ imageKey: "img_v2_final" })
    try {
      const card = createCard()
      await card.start()
      await card.update("Example:\n```\n![logo](https://img.example.com/logo.png)\n```")
      await card.close()

      const finalContent = fetchState.answerUpdates.at(-1)!
      expect(finalContent).toContain("![logo](https://img.example.com/logo.png)")
      expect(fetchState.requests.some((request) => request.url.endsWith("/im/v1/images"))).toBe(false)
    } finally {
      fetchState.restore()
    }
  })
})
