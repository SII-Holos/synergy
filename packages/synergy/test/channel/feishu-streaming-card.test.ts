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

function installCardFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response> = () => response(),
) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url.endsWith("/cardkit/v1/cards")) {
      return response({ data: { card_id: "card_test" } })
    }
    if (url.endsWith("/im/v1/messages/message_root/reply")) {
      return response({ data: { message_id: "message_card" } })
    }
    return handler(url, init)
  }) as typeof fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

function createCard(
  sendFallback?: (text: string) => Promise<void>,
  options?: { requestTimeoutMs?: number; throttleMs?: number },
) {
  return new FeishuStreamingCard({
    apiBase: "https://open.feishu.test/open-apis",
    getAccessToken: async () => "token_test",
    chatId: "chat_test",
    replyToMessageId: "message_root",
    throttleMs: options?.throttleMs ?? 0,
    requestTimeoutMs: options?.requestTimeoutMs,
    sendFallback,
  })
}

describe("Feishu streaming card snapshots", () => {
  test("renders a canonical snapshot that rewrites previously streamed text", async () => {
    const answerUpdates: string[] = []
    const restoreFetch = installCardFetch((url, init) => {
      if (url.includes("/elements/answer_content/content")) {
        answerUpdates.push(String(requestBody(init).content))
      }
      return response()
    })

    try {
      const card = createCard()
      await card.start()
      await card.update("I need your city before I can check the weather.")
      await card.update("Great, I will create the Shanghai weather reminder.")
      await card.close()

      expect(answerUpdates.at(-1)).toBe("Great, I will create the Shanghai weather reminder.")
    } finally {
      restoreFetch()
    }
  })

  test("preserves queued tool progress when close starts before pending renders", async () => {
    const toolUpdates: string[] = []
    const restoreFetch = installCardFetch((url, init) => {
      if (url.includes("/elements/tool_content/content")) {
        toolUpdates.push(String(requestBody(init).content))
      }
      return response()
    })

    try {
      const card = createCard()
      await card.start()
      const textUpdate = card.update("draft")
      const toolUpdate = card.updateToolProgress([
        { id: "tool_1", tool: "webfetch", title: "Shanghai weather", status: "completed" },
      ])
      const close = card.close("final answer")
      await Promise.all([textUpdate, toolUpdate, close])

      expect(toolUpdates.at(-1)).toContain("Shanghai weather")
      expect(toolUpdates.at(-1)).toContain("1/1 completed")
    } finally {
      restoreFetch()
    }
  })
  test("coalesces one hundred rapid snapshots to the latest canonical answer", async () => {
    const answerUpdates: string[] = []
    const restoreFetch = installCardFetch(async (url, init) => {
      if (url.includes("/elements/answer_content/content")) {
        answerUpdates.push(String(requestBody(init).content))
        await Bun.sleep(10)
      }
      return response()
    })

    try {
      const card = createCard(undefined, { throttleMs: 10 })
      await card.start()
      await Promise.all(Array.from({ length: 100 }, (_, index) => card.update(`snapshot ${index}`)))
      await card.close("snapshot 99")

      expect(answerUpdates.at(-1)).toBe("snapshot 99")
      expect(answerUpdates.length).toBeLessThanOrEqual(2)
    } finally {
      restoreFetch()
    }
  })
})

describe("Feishu streaming card recovery", () => {
  test("retries transient element failures before accepting the update", async () => {
    let answerAttempts = 0
    const fallback: string[] = []
    const restoreFetch = installCardFetch((url) => {
      if (url.includes("/elements/answer_content/content")) {
        answerAttempts += 1
        if (answerAttempts < 3) {
          return response({ status: 502, code: 230099, msg: "upstream unavailable" })
        }
      }
      return response()
    })

    try {
      const card = createCard(async (text) => {
        fallback.push(text)
      })
      await card.start()
      await card.update("final answer")
      await card.close("final answer")

      expect(answerAttempts).toBe(3)
      expect(fallback).toEqual([])
    } finally {
      restoreFetch()
    }
  })

  test("stops card mutations after Feishu reports a terminal streaming state", async () => {
    let answerAttempts = 0
    const fallback: string[] = []
    const restoreFetch = installCardFetch((url) => {
      if (url.includes("/elements/answer_content/content")) {
        answerAttempts += 1
        return response({ code: 300309, msg: "streaming mode is closed" })
      }
      return response()
    })

    try {
      const card = createCard(async (text) => {
        fallback.push(text)
      })
      await card.start()
      await card.update("draft").catch(() => {})
      await card.update("latest canonical answer")
      await card.close("latest canonical answer")

      expect(answerAttempts).toBe(1)
      expect(fallback).toEqual(["latest canonical answer"])
    } finally {
      restoreFetch()
    }
  })

  test("times out hung CardKit mutations and bounds their retry attempts", async () => {
    let answerAttempts = 0
    const fallback: string[] = []
    const restoreFetch = installCardFetch((url, init) => {
      if (!url.includes("/elements/answer_content/content")) return response()
      answerAttempts += 1
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    })

    try {
      const card = createCard(
        async (text) => {
          fallback.push(text)
        },
        { requestTimeoutMs: 10 },
      )
      await card.start()
      const startedAt = performance.now()
      await expect(card.update("final answer")).rejects.toBeDefined()
      expect(performance.now() - startedAt).toBeLessThan(1_000)
      expect(answerAttempts).toBe(3)

      await card.close("final answer")
      expect(answerAttempts).toBe(6)
      expect(fallback).toEqual(["final answer"])
    } finally {
      restoreFetch()
    }
  })

  test("paces every CardKit mutation at no more than ten requests per second", async () => {
    const mutationTimes: number[] = []
    const restoreFetch = installCardFetch((url) => {
      if (url.includes("/cardkit/v1/cards/card_test/")) {
        mutationTimes.push(performance.now())
      }
      return response()
    })

    try {
      const card = createCard()
      await card.start()
      await card.update("answer")
      await card.updateToolProgress([{ id: "tool_1", tool: "webfetch", status: "completed" }])
      await card.close("answer")

      expect(mutationTimes.length).toBeGreaterThanOrEqual(4)
      for (let index = 1; index < mutationTimes.length; index += 1) {
        expect(mutationTimes[index]! - mutationTimes[index - 1]!).toBeGreaterThanOrEqual(80)
      }
    } finally {
      restoreFetch()
    }
  })

  test("uses one full-text fallback instead of sending a card above the 30 KB limit", async () => {
    const longAnswer = "答".repeat(11_000)
    const answerUpdates: string[] = []
    const fallback: string[] = []
    const restoreFetch = installCardFetch((url, init) => {
      if (url.includes("/elements/answer_content/content")) {
        answerUpdates.push(String(requestBody(init).content))
      }
      return response()
    })

    try {
      const card = createCard(async (text) => {
        fallback.push(text)
      })
      await card.start()
      await card.update(longAnswer)
      await card.close(longAnswer)

      expect(answerUpdates).not.toContain(longAnswer)
      expect(fallback).toEqual([longAnswer])
    } finally {
      restoreFetch()
    }
  })
})

describe("Feishu streaming card finalization", () => {
  test("falls back to a text reply when Feishu rejects the final answer update", async () => {
    const fallback: string[] = []
    let finalAnswerRejected = false
    const restoreFetch = installCardFetch((url, init) => {
      if (url.includes("/elements/answer_content/content")) {
        const body = requestBody(init)
        if (body.content === "final answer") {
          finalAnswerRejected = true
          return response({ code: 230099, msg: "content rejected" })
        }
      }
      return response()
    })

    try {
      const card = createCard(async (text) => {
        fallback.push(text)
      })
      await card.start()
      await card.update("progress")
      await card.close("final answer")

      expect(finalAnswerRejected).toBe(true)
      expect(fallback).toEqual(["final answer"])
    } finally {
      restoreFetch()
    }
  })

  test("retries the final answer when the matching streaming update was rejected", async () => {
    const fallback: string[] = []
    let answerAttempts = 0
    const restoreFetch = installCardFetch((url, init) => {
      if (url.includes("/elements/answer_content/content")) {
        const body = requestBody(init)
        if (body.content === "final answer") {
          answerAttempts += 1
          return response({ code: 230099, msg: "content rejected" })
        }
      }
      return response()
    })

    try {
      const card = createCard(async (text) => {
        fallback.push(text)
      })
      await card.start()
      await card.update("final answer").catch(() => {})
      await card.close("final answer")

      expect(answerAttempts).toBe(2)
      expect(fallback).toEqual(["final answer"])
    } finally {
      restoreFetch()
    }
  })

  test("falls back to a text reply when the final answer update returns an HTTP error", async () => {
    const fallback: string[] = []
    const restoreFetch = installCardFetch((url, init) => {
      if (url.includes("/elements/answer_content/content")) {
        const body = requestBody(init)
        if (body.content === "final answer") {
          return response({ status: 502, code: 230099, msg: "upstream unavailable" })
        }
      }
      return response()
    })

    try {
      const card = createCard(async (text) => {
        fallback.push(text)
      })
      await card.start()
      await card.close("final answer")

      expect(fallback).toEqual(["final answer"])
    } finally {
      restoreFetch()
    }
  })

  test("falls back to a text reply when Feishu cannot close streaming mode", async () => {
    const fallback: string[] = []
    const restoreFetch = installCardFetch((url) => {
      if (url.endsWith("/cardkit/v1/cards/card_test/settings")) {
        return response({ code: 300309, msg: "streaming mode already closed" })
      }
      return response()
    })

    try {
      const card = createCard(async (text) => {
        fallback.push(text)
      })
      await card.start()
      await card.close("final answer")

      expect(fallback).toEqual(["final answer"])
    } finally {
      restoreFetch()
    }
  })

  test("sends the fallback at most once when close is called concurrently", async () => {
    const fallback: string[] = []
    const restoreFetch = installCardFetch((url) => {
      if (url.includes("/elements/answer_content/content")) {
        return response({ code: 230099, msg: "content rejected" })
      }
      return response()
    })

    try {
      const card = createCard(async (text) => {
        fallback.push(text)
      })
      await card.start()
      await Promise.all([card.close("final answer"), card.close("final answer")])

      expect(fallback).toEqual(["final answer"])
    } finally {
      restoreFetch()
    }
  })
})
