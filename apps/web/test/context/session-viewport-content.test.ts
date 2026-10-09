import { expect, test } from "bun:test"
import type { Message, SessionPartSummary } from "@ericsanchezok/synergy-sdk/client"
import { planSessionViewportContent, readSessionViewportContent } from "../../src/context/session-viewport-content"

const message = (id: string, role: "user" | "assistant") => ({ id, role }) as Message
const part = (messageID: string, id: string, bytes = 10): SessionPartSummary => ({
  id,
  messageID,
  sessionID: "session",
  type: "text",
  preview: "",
  content: { version: id, bytes },
})

test("prepares the whole initial window in one pass with versioned bodies", async () => {
  const calls: string[] = []
  const result = await readSessionViewportContent({
    messages: [
      message("old", "user"),
      message("root", "user"),
      ...Array.from({ length: 20 }, (_, i) => message(`reply${i}`, "assistant")),
    ],
    signal: new AbortController().signal,
    page: async (id) => {
      calls.push(id)
      return { items: [part(id, id)], hasMore: false, hasEarlier: false, nextCursor: null, previousCursor: null }
    },
    body: async (summary) => ({
      part: { id: summary.id, messageID: summary.messageID, sessionID: "session", type: "text", text: "ready" },
      version: summary.content.version,
    }),
  })
  // Whole initial window now seeds in one pass; the legacy tail-only
  // (root + last 3) behavior let late-mounted rows refetch part pages and
  // restarted the cascade this test suite's Blueprint removes.
  expect(calls).toEqual(["old", "root", ...Array.from({ length: 20 }, (_, i) => `reply${i}`)])
  // Bodies stay bottom-up budgeted (16 parts ≤128KB): the newest 16 replies
  // are eager; older/roots defer to the lazy materializer path.
  expect(result.bodies.map((item) => item.version)).toEqual(Array.from({ length: 16 }, (_, i) => `reply${19 - i}`))
})

test("keeps the page fan-out inside the endpoint's ≤100-ID cap with tail priority", async () => {
  const calls: string[] = []
  const result = await readSessionViewportContent({
    messages: Array.from({ length: 140 }, (_, i) => message(`m${i}`, i % 2 ? "assistant" : "user")),
    signal: new AbortController().signal,
    page: async (id) => {
      calls.push(id)
      return { items: [], hasMore: false, hasEarlier: false, nextCursor: null, previousCursor: null }
    },
    body: async (summary) => ({
      part: { id: summary.id, messageID: summary.messageID, sessionID: "session", type: "text", text: "ready" },
      version: summary.content.version,
    }),
  })
  expect(calls).toHaveLength(100)
  expect(calls[0]).toBe("m40")
  expect(calls.at(-1)).toBe("m139")
  // Bodies stay bounded by the legacy bottom-up budget even though every
  // message in the window issued a page read.
  expect(result.bodies.length).toBeLessThanOrEqual(16)
})

test("keeps oversized and failed bodies lazy without discarding accepted summaries", async () => {
  const calls: string[] = []
  const result = await readSessionViewportContent({
    messages: [message("root", "user")],
    signal: new AbortController().signal,
    page: async () => ({
      items: [part("root", "large", 200_000), part("root", "failed"), part("root", "good")],
      hasMore: false,
      hasEarlier: false,
      nextCursor: null,
      previousCursor: null,
    }),
    body: async (summary) => {
      calls.push(summary.id)
      if (summary.id === "failed") throw new Error("temporary failure")
      return {
        part: { id: summary.id, messageID: summary.messageID, sessionID: "session", type: "text", text: "ready" },
        version: summary.content.version,
      }
    },
  })
  expect(calls).toEqual(["good", "failed"])
  expect(result.pages.root?.items.map((item) => item.id)).toEqual(["large", "failed", "good"])
  expect(result.bodies.map((item) => item.version)).toEqual(["good"])
})

test("rejects cancellation and never admits a body with another version", async () => {
  const controller = new AbortController()
  const input = {
    messages: [message("root", "user")],
    signal: controller.signal,
    page: async () => ({
      items: [part("root", "part")],
      hasMore: false,
      hasEarlier: false,
      nextCursor: null,
      previousCursor: null,
    }),
    body: async () => ({
      part: { id: "part", messageID: "root", sessionID: "session", type: "text" as const, text: "stale" },
      version: "stale",
    }),
  }
  expect((await readSessionViewportContent(input)).bodies).toEqual([])
  controller.abort()
  expect(readSessionViewportContent(input)).rejects.toThrow()
})

test("limits bodies by count and bytes and rejects superseded snapshots before publication", async () => {
  const read = async (bytes: number) =>
    readSessionViewportContent({
      messages: [message("root", "user")],
      signal: new AbortController().signal,
      page: async () => ({
        items: Array.from({ length: 30 }, (_, index) => part("root", String(index), bytes)),
        hasMore: false,
        hasEarlier: false,
        nextCursor: null,
        previousCursor: null,
      }),
      body: async (summary) => ({
        part: { id: summary.id, messageID: "root", sessionID: "session", type: "text", text: "ready" },
        version: summary.content.version,
      }),
    })
  const content = await read(10)
  expect(content.bodies).toHaveLength(16)
  expect((await read(32 * 1024)).bodies).toHaveLength(4)
  expect(planSessionViewportContent(content, () => "preserve")).toEqual({ pages: {}, bodies: [] })
  expect(planSessionViewportContent(content, () => "retry")).toBeUndefined()
  expect(planSessionViewportContent(content, () => "apply")).toEqual(content)
})
