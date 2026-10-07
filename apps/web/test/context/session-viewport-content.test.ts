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

test("prepares a bounded latest viewport with the root and versioned bodies", async () => {
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
  expect(calls).toEqual(["root", "reply17", "reply18", "reply19"])
  expect(result.bodies.map((item) => item.version)).toEqual(["reply19", "reply18", "reply17", "root"])
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
