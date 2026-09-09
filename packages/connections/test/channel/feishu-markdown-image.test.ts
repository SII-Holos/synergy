import { describe, expect, test } from "bun:test"
import { sendFeishuMarkdownCard } from "../../src/channel/provider/feishu/send-card"
import { degradeMarkdownImages } from "../../src/channel/provider/feishu/markdown-image"

const API_BASE = "https://open.feishu.test/open-apis"

function apiContext(overrides: Record<string, unknown> = {}) {
  return {
    apiBase: API_BASE,
    getAccessToken: async () => "token_test",
    ...overrides,
  }
}

type Route = {
  match: (url: string) => boolean
  response: Response | (() => Response)
}

function mockFetch(routes: Route[]) {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; body?: unknown }> = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    requests.push({ url, body: init?.body })
    for (const route of routes) {
      if (route.match(url)) {
        const response = typeof route.response === "function" ? route.response() : route.response
        return response
      }
    }
    return new Response(JSON.stringify({ code: -1, msg: `unexpected request: ${url}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
  return { originalFetch, requests }
}

function cardRoutes() {
  return [
    {
      match: (url: string) => url.split("?")[0]!.endsWith("/cardkit/v1/cards"),
      response: new Response(JSON.stringify({ code: 0, data: { card_id: "card_md" } }), {
        headers: { "Content-Type": "application/json" },
      }),
    },
    {
      match: (url: string) => url.split("?")[0]!.endsWith("/im/v1/messages"),
      response: new Response(JSON.stringify({ code: 0, data: { message_id: "msg_reply" } }), {
        headers: { "Content-Type": "application/json" },
      }),
    },
  ]
}

function imageUploadRoute(imageKey = "img_v2_uploaded") {
  return {
    match: (url: string) => url.split("?")[0]!.endsWith("/im/v1/images"),
    response: new Response(JSON.stringify({ code: 0, data: { image_key: imageKey } }), {
      headers: { "Content-Type": "application/json" },
    }),
  }
}

function imageDownloadRoute(url: string, options: { ok?: boolean; contentType?: string } = {}) {
  const { ok = true, contentType = "image/png" } = options
  return {
    match: (requestUrl: string) => requestUrl === url,
    response: () =>
      ok
        ? new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": contentType } })
        : new Response("not found", { status: 404 }),
  }
}

function cardContentFrom(requests: Array<{ url: string; body?: unknown }>): string {
  const cardRequest = requests.find((request) => request.url.split("?")[0]!.endsWith("/cardkit/v1/cards"))
  if (!cardRequest || typeof cardRequest.body !== "string") throw new Error("card request missing")
  const parsed = JSON.parse(cardRequest.body) as { data: string }
  const cardJson = JSON.parse(parsed.data) as { body: { elements: Array<{ tag: string; content: string }> } }
  return cardJson.body.elements[0]?.content ?? ""
}

describe("Feishu markdown card image materialization", () => {
  test("downloads and uploads a markdown image URL, replacing it with an image_key", async () => {
    const { originalFetch, requests } = mockFetch([
      imageDownloadRoute("https://img.example.com/logo.png"),
      imageUploadRoute("img_v2_uploaded"),
      ...cardRoutes(),
    ])

    try {
      const result = await sendFeishuMarkdownCard({
        ...apiContext(),
        chatId: "chat_1",
        text: "Here is a logo:\n\n![Logo](https://img.example.com/logo.png)",
      })

      expect(result?.messageId).toBe("msg_reply")
      expect(cardContentFrom(requests)).toContain("![Logo](img_v2_uploaded)")
      expect(requests.some((request) => request.url === "https://img.example.com/logo.png")).toBe(true)
      expect(requests.some((request) => request.url.split("?")[0]!.endsWith("/im/v1/images"))).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("keeps non-image URLs untouched", async () => {
    const { originalFetch, requests } = mockFetch([
      imageDownloadRoute("https://img.example.com/logo.png"),
      imageUploadRoute("img_v2_uploaded"),
      ...cardRoutes(),
    ])

    try {
      const text = "Check [OpenAI](https://openai.com) and https://example.com/docs"
      await sendFeishuMarkdownCard({ ...apiContext(), chatId: "chat_1", text })

      expect(cardContentFrom(requests)).toBe(text)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("degrades a failed image download to a link without failing the card", async () => {
    const { originalFetch, requests } = mockFetch([
      imageDownloadRoute("https://img.example.com/broken.png", { ok: false }),
      ...cardRoutes(),
    ])

    try {
      const result = await sendFeishuMarkdownCard({
        ...apiContext(),
        chatId: "chat_1",
        text: "Logo: ![Logo](https://img.example.com/broken.png)",
      })

      expect(result?.messageId).toBe("msg_reply")
      expect(cardContentFrom(requests)).toContain("[Logo](https://img.example.com/broken.png)")
      expect(requests.some((request) => request.url.split("?")[0]!.endsWith("/im/v1/images"))).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("degrades a non-image content type to a link", async () => {
    const { originalFetch, requests } = mockFetch([
      imageDownloadRoute("https://img.example.com/not-image.png", { contentType: "text/html" }),
      ...cardRoutes(),
    ])

    try {
      await sendFeishuMarkdownCard({
        ...apiContext(),
        chatId: "chat_1",
        text: "![Logo](https://img.example.com/not-image.png)",
      })

      expect(cardContentFrom(requests)).toContain("[Logo](https://img.example.com/not-image.png)")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("strips non-http image syntax as plain text", async () => {
    const { originalFetch, requests } = mockFetch([...cardRoutes()])

    try {
      await sendFeishuMarkdownCard({
        ...apiContext(),
        chatId: "chat_1",
        text: "Inline data: ![Logo](data:image/png;base64,AAAA)",
      })

      expect(cardContentFrom(requests)).toBe("Inline data: Logo")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("uploads multiple images and keeps failures as links", async () => {
    const { originalFetch, requests } = mockFetch([
      imageDownloadRoute("https://img.example.com/ok.png"),
      imageDownloadRoute("https://img.example.com/broken.png", { ok: false }),
      imageUploadRoute("img_v2_uploaded"),
      ...cardRoutes(),
    ])

    try {
      await sendFeishuMarkdownCard({
        ...apiContext(),
        chatId: "chat_1",
        text: "![One](https://img.example.com/ok.png) and ![Two](https://img.example.com/broken.png)",
      })

      const content = cardContentFrom(requests)
      expect(content).toContain("![One](img_v2_uploaded)")
      expect(content).toContain("[Two](https://img.example.com/broken.png)")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("does not fetch or upload when there are no images", async () => {
    const { originalFetch, requests } = mockFetch([...cardRoutes()])

    try {
      await sendFeishuMarkdownCard({
        ...apiContext(),
        chatId: "chat_1",
        text: "Plain **bold** text with `code`",
      })

      expect(requests.some((request) => request.url.split("?")[0]!.endsWith("/im/v1/images"))).toBe(false)
      expect(cardContentFrom(requests)).toBe("Plain **bold** text with `code`")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("does not materialize image syntax inside inline code", async () => {
    const { originalFetch, requests } = mockFetch([...cardRoutes()])

    try {
      const text =
        "Use `` ![logo](https://img.example.com/logo.png) `` in code, or `![alt](data:image/png;base64,AAAA)`"
      await sendFeishuMarkdownCard({ ...apiContext(), chatId: "chat_1", text })

      expect(requests.some((request) => request.url.startsWith("https://img.example.com"))).toBe(false)
      expect(requests.some((request) => request.url.split("?")[0]!.endsWith("/im/v1/images"))).toBe(false)
      expect(cardContentFrom(requests)).toBe(text)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("does not materialize image syntax inside a fenced code block", async () => {
    const { originalFetch, requests } = mockFetch([...cardRoutes()])

    try {
      const text = "Example:\n```markdown\n![logo](https://img.example.com/logo.png)\n```\nDone"
      await sendFeishuMarkdownCard({ ...apiContext(), chatId: "chat_1", text })

      expect(requests.some((request) => request.url.startsWith("https://img.example.com"))).toBe(false)
      expect(requests.some((request) => request.url.split("?")[0]!.endsWith("/im/v1/images"))).toBe(false)
      expect(cardContentFrom(requests)).toBe(text)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("does not materialize escaped image syntax", async () => {
    const { originalFetch, requests } = mockFetch([...cardRoutes()])

    try {
      const text = "Escaped: \\![logo](https://img.example.com/logo.png)"
      await sendFeishuMarkdownCard({ ...apiContext(), chatId: "chat_1", text })

      expect(requests.some((request) => request.url.startsWith("https://img.example.com"))).toBe(false)
      expect(requests.some((request) => request.url.split("?")[0]!.endsWith("/im/v1/images"))).toBe(false)
      expect(cardContentFrom(requests)).toBe(text)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("materializes real images while leaving code-block examples untouched", async () => {
    const { originalFetch, requests } = mockFetch([
      imageDownloadRoute("https://img.example.com/real.png"),
      imageUploadRoute("img_v2_uploaded"),
      ...cardRoutes(),
    ])

    try {
      const text =
        "Real: ![logo](https://img.example.com/real.png)\n\nCode example:\n```\n![logo](https://img.example.com/fake.png)\n```"
      await sendFeishuMarkdownCard({ ...apiContext(), chatId: "chat_1", text })

      const content = cardContentFrom(requests)
      expect(content).toContain("![logo](img_v2_uploaded)")
      expect(content).toContain("![logo](https://img.example.com/fake.png)")
      expect(requests.filter((request) => request.url === "https://img.example.com/real.png")).toHaveLength(1)
      expect(requests.some((request) => request.url === "https://img.example.com/fake.png")).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("degradeMarkdownImages streaming-path robustness", () => {
  test("does not hang on a lone tilde character", () => {
    const text = "Use ~/path please"
    expect(degradeMarkdownImages(text)).toBe(text)
  })

  test("does not hang on strikethrough syntax", () => {
    const text = "This is ~~strikethrough~~ text"
    expect(degradeMarkdownImages(text)).toBe(text)
  })

  test("does not hang on tilde-heavy markdown and still degrades real images", () => {
    const text = "Home ~/me\n\n![Logo](https://img.example.com/logo.png)\n\n~~done~~"
    const result = degradeMarkdownImages(text)
    expect(result).toContain("[Logo](https://img.example.com/logo.png)")
    expect(result).toContain("~~done~~")
  })

  test("leaves inline code and plain text untouched", () => {
    const text = "Use `![alt](data:image/png;base64,AAAA)` literally"
    expect(degradeMarkdownImages(text)).toBe(text)
  })
})
