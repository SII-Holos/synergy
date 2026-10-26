import { describe, expect, test } from "bun:test"
import { PromptBudgeter } from "../../src/session/prompt-budgeter"
import { testRuntime } from "../support/runtime"
import { MessageV2 } from "../../src/session/message-v2"
import type { ModelMessage } from "ai"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sessionID = "test-session"

/**
 * Generate a synthetic image data URL with deterministic content.
 * Produces a valid-looking `data:image/png;base64,...` URL that can be
 * hashed consistently.
 */
function imageDataUrl(id: string): string {
  const payload = Buffer.from(`fake-image-content-${id}`).toString("base64")
  return `data:image/png;base64,${payload}`
}

/**
 * Generate a large base64 image data URL with a known content blob.
 * Used for token-inflation tests. The base64 payload is roughly 4/3 the
 * size of `content`.
 */
function largeImageDataUrl(content: string): string {
  const payload = Buffer.from(content).toString("base64")
  return `data:image/png;base64,${payload}`
}

/**
 * Compute a SHA-256 hash of a URL, matching the `Asset.generateId()` pattern
 * (first 16 hex characters).
 */
export function urlHash(url: string): string {
  return new Bun.CryptoHasher("sha256").update(url).digest("hex").slice(0, 16)
}

// ---- Message builders ----

function basePart(messageID: string, id: string) {
  return { id, sessionID, messageID }
}

function userInfo(id: string): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.User
}

function imageAttachmentPart(opts: {
  id: string
  messageID: string
  filename: string
  url: string
}): MessageV2.AttachmentPart {
  return {
    ...basePart(opts.messageID, opts.id),
    type: "attachment",
    mime: "image/png",
    filename: opts.filename,
    url: opts.url,
    model: { mode: "provider-file", summary: `${opts.filename} (image/png)` },
  } as unknown as MessageV2.AttachmentPart
}

function textAttachmentPart(opts: {
  id: string
  messageID: string
  filename: string
  url: string
}): MessageV2.AttachmentPart {
  return {
    ...basePart(opts.messageID, opts.id),
    type: "attachment",
    mime: "text/plain",
    filename: opts.filename,
    url: opts.url,
    model: { mode: "provider-file", summary: `${opts.filename} (text/plain)` },
  } as unknown as MessageV2.AttachmentPart
}

function userMsgWithParts(id: string, parts: MessageV2.Part[]): MessageV2.WithParts {
  return { info: userInfo(id), parts }
}

// ---- Output inspectors ----

interface ExtractedProviderFilePart {
  data: unknown
  mediaType: string
  filename?: string
}

/** Collect all file parts from a ModelMessage[] result (after convertToModelMessages). */
function collectProviderFileParts(modelMessages: ModelMessage[]): ExtractedProviderFilePart[] {
  const result: ExtractedProviderFilePart[] = []
  for (const mm of modelMessages) {
    if (typeof mm.content === "string") continue
    for (const part of mm.content) {
      if (part.type === "file") {
        result.push({
          data: (part as any).data,
          mediaType: part.mediaType,
          filename: part.filename,
        })
      }
    }
  }
  return result
}

/** Collect all text parts whose text starts with "[Image:" (placeholder). */
function collectImagePlaceholders(modelMessages: ModelMessage[]): string[] {
  const result: string[] = []
  for (const mm of modelMessages) {
    if (typeof mm.content === "string") continue
    for (const part of mm.content) {
      if (part.type === "text" && (part as any).text?.startsWith?.("[Image:")) {
        result.push((part as any).text)
      }
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// A. toModelMessage image count limit
// ---------------------------------------------------------------------------

describe("session.message-v2.toModelMessage image limit", () => {
  test("all images sent as base64 when maxHistoryImages is not provided (backward compatible)", async () => {
    const urls = Array.from({ length: 10 }, (_, i) => imageDataUrl(`img-${i}`))
    const msgs = urls.map((url, i) => {
      const msgID = `m${i}`
      return userMsgWithParts(msgID, [
        imageAttachmentPart({ id: `p${i}`, messageID: msgID, filename: `img-${i}.png`, url }),
      ])
    })

    // Single-arg call — works today, should continue working
    const result = await MessageV2.toModelMessage(msgs)
    const providerFileParts = collectProviderFileParts(result)

    expect(providerFileParts).toHaveLength(10)
    for (let i = 0; i < 10; i++) {
      expect(providerFileParts[i].data).toEqual({ type: "url", url: new URL(urls[i]!) })
    }
    expect(collectImagePlaceholders(result)).toHaveLength(0)
  })

  test("limits to last N unique images when maxHistoryImages is set to 5", async () => {
    const urls = Array.from({ length: 10 }, (_, i) => imageDataUrl(`img-${i}`))
    const msgs = urls.map((url, i) => {
      const msgID = `m${i}`
      return userMsgWithParts(msgID, [
        imageAttachmentPart({ id: `p${i}`, messageID: msgID, filename: `img-${i}.png`, url }),
      ])
    })

    // Two-arg call — will compile via `as any` cast; fails at runtime
    // because current toModelMessage ignores the config and returns all 10.
    const result = await (MessageV2.toModelMessage as any)(msgs, { maxHistoryImages: 5 })
    const providerFileParts = collectProviderFileParts(result)
    const placeholders = collectImagePlaceholders(result)

    // Last 5 images (messages 5–9) should have base64 data
    expect(providerFileParts).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expect(providerFileParts[i].data).toEqual({ type: "url", url: new URL(urls[5 + i]!) })
    }

    // First 5 images (messages 0–4) should be placeholders
    expect(placeholders).toHaveLength(5)
    for (let i = 0; i < 5; i++) {
      expect(placeholders[i]).toContain(`img-${i}.png`)
      expect(placeholders[i]).toContain("[Image:")
      expect(placeholders[i]).toContain("previously shared")
    }

    const projection = await MessageV2.projectModelMessages(msgs, { maxHistoryImages: 5 })
    expect(projection.provenance.categories.attachments.filter((entry) => entry.text)).toMatchObject(
      placeholders.map((text) => ({ text })),
    )
    expect(projection.provenance.items.attachments).toBe(10)
  })

  test("replaces all images with placeholders when maxHistoryImages is 0", async () => {
    const urls = Array.from({ length: 3 }, (_, i) => imageDataUrl(`img-${i}`))
    const msgs = urls.map((url, i) => {
      const msgID = `m${i}`
      return userMsgWithParts(msgID, [
        imageAttachmentPart({ id: `p${i}`, messageID: msgID, filename: `img-${i}.png`, url }),
      ])
    })

    const result = await (MessageV2.toModelMessage as any)(msgs, { maxHistoryImages: 0 })
    const providerFileParts = collectProviderFileParts(result)
    const placeholders = collectImagePlaceholders(result)

    expect(providerFileParts).toHaveLength(0)
    expect(placeholders).toHaveLength(3)

    const projection = await MessageV2.projectModelMessages(msgs, { maxHistoryImages: 0 })
    expect(projection.provenance.categories.attachments.filter((entry) => entry.text)).toMatchObject(
      placeholders.map((text) => ({ text })),
    )
    expect(projection.provenance.items.attachments).toBe(3)
  })

  test("text files are not affected by image limit", async () => {
    const urls = Array.from({ length: 3 }, (_, i) => imageDataUrl(`img-${i}`))
    const msgs = urls.map((url, i) => {
      const msgID = `m${i}`
      return userMsgWithParts(msgID, [
        imageAttachmentPart({ id: `img-${i}`, messageID: msgID, filename: `img-${i}.png`, url }),
        textAttachmentPart({
          id: `txt-${i}`,
          messageID: msgID,
          filename: `doc-${i}.txt`,
          url: `https://example.com/doc-${i}.txt`,
        }),
      ])
    })

    const result = await (MessageV2.toModelMessage as any)(msgs, { maxHistoryImages: 2 })
    const providerFileParts = collectProviderFileParts(result)
    const placeholders = collectImagePlaceholders(result)

    // Only 2 images kept (last 2 unique)
    const imageParts = providerFileParts.filter((p) => p.mediaType === "image/png")
    expect(imageParts).toHaveLength(2)
    // 1 image replaced with placeholder
    expect(placeholders).toHaveLength(1)
    // 3 text files should all still be present (text/plain is not an image)
    const textParts = providerFileParts.filter((p) => p.mediaType === "text/plain")
    expect(textParts).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// B. toModelMessage image hash-based dedup
// ---------------------------------------------------------------------------

describe("session.message-v2.toModelMessage image dedup", () => {
  test("identical images (same URL) count as one unique image toward the limit", async () => {
    const dupURL = imageDataUrl("duplicate")

    // 3 identical images (same URL → same hash → 1 unique)
    const dupParts = [0, 1, 2].map((i) =>
      imageAttachmentPart({ id: `dup-${i}`, messageID: `d${i}`, filename: `img.png`, url: dupURL }),
    )
    // 2 unique images
    const uniqueParts = [3, 4].map((i) =>
      imageAttachmentPart({
        id: `u-${i}`,
        messageID: `u${i}`,
        filename: `unique-${i}.png`,
        url: imageDataUrl(`unique-${i}`),
      }),
    )

    const allParts = [...dupParts, ...uniqueParts]
    const msgs = allParts.map((p, i) => userMsgWithParts(`msg-${i}`, [p]))

    // 3 dup (1 unique) + 2 unique = 3 unique total. Limit 3 → all kept.
    const result = await (MessageV2.toModelMessage as any)(msgs, { maxHistoryImages: 3 })
    const providerFileParts = collectProviderFileParts(result)
    const placeholders = collectImagePlaceholders(result)

    expect(providerFileParts).toHaveLength(5)
    expect(placeholders).toHaveLength(0)
  })

  test("different images with same filename count as separate unique images", async () => {
    const urlA = imageDataUrl("content-A")
    const urlB = imageDataUrl("content-B")
    const urlC = imageDataUrl("content-C")

    const msgs = [urlA, urlB, urlC].map((url, i) => {
      const msgID = `m${i}`
      return userMsgWithParts(msgID, [
        imageAttachmentPart({ id: `p${i}`, messageID: msgID, filename: `photo.png`, url }),
      ])
    })

    // 3 unique images, limit 2 → oldest gets replaced
    const result = await (MessageV2.toModelMessage as any)(msgs, { maxHistoryImages: 2 })
    const providerFileParts = collectProviderFileParts(result)
    const placeholders = collectImagePlaceholders(result)

    // Only 2 file parts kept (last 2 unique images)
    expect(providerFileParts).toHaveLength(2)
    // Oldest image (urlA, message 0) should be a placeholder
    expect(placeholders).toHaveLength(1)
    expect(placeholders[0]).toContain("photo.png")
    // The two file parts should be urlB and urlC (messages 1 and 2)
    expect(providerFileParts[0].data).toEqual({ type: "url", url: new URL(urlB) })
    expect(providerFileParts[1].data).toEqual({ type: "url", url: new URL(urlC) })
  })
})

describe("PromptBudgeter image payload measurement", () => {
  test.each(["file", "image"] as const)(
    "%s payload size cannot inflate the history budget or mutate image data",
    async (kind) => {
      await using runtime = await testRuntime()
      await runtime.run(async () => {
        const totals: number[] = []
        for (const size of [32, 50_000]) {
          const data = largeImageDataUrl("x".repeat(size))
          const messages: ModelMessage[] = [
            { role: "user", content: "Retain the earlier user restriction." },
            { role: "assistant", content: "Observed evidence." },
            {
              role: "user",
              content: [
                { type: "text", text: "Check this image." },
                kind === "file"
                  ? { type: "file", data, mediaType: "image/png", filename: "test.png" }
                  : { type: "image", image: data, mediaType: "image/png" },
              ],
            },
          ]
          const snapshot = structuredClone(messages)
          const measured = await PromptBudgeter.measure({ system: [], messages, toolDefinitions: [] }, "fixture")
          totals.push(measured.total)
          expect(measured.total).toBeLessThan(1000)
          expect(messages).toEqual(snapshot)
        }
        expect(totals[0]).toBeGreaterThan(0)
        expect(totals[0]).toBe(totals[1])
      })
    },
  )
})

// ---------------------------------------------------------------------------
// Hash utility tests
// ---------------------------------------------------------------------------

describe("image hash (used for dedup)", () => {
  test("same URL produces same hash", () => {
    const url = "data:image/png;base64,abc123"
    expect(urlHash(url)).toBe(urlHash(url))
  })

  test("different URLs produce different hashes", () => {
    expect(urlHash(imageDataUrl("content-A"))).not.toBe(urlHash(imageDataUrl("content-B")))
  })

  test("hash is 16 hex characters", () => {
    const h = urlHash(imageDataUrl("test"))
    expect(h).toHaveLength(16)
    expect(h).toMatch(/^[0-9a-f]+$/)
  })

  test("hash matches Asset.generateId pattern", () => {
    // Asset.generateId uses sha256 first 16 hex chars
    const url = imageDataUrl("verify-pattern")
    const hash = urlHash(url)
    const fullHash = new Bun.CryptoHasher("sha256").update(url).digest("hex")
    expect(fullHash).toStartWith(hash)
  })
})
