import { expect, test } from "bun:test"
import type { SessionPartPage, SessionPartSummary } from "@ericsanchezok/synergy-sdk"
import { createPartSummaryLoader, planPartSummaryPage } from "../../src/context/part-summary-loader"

const summary = (id: string, version = "one"): SessionPartSummary => ({
  id,
  sessionID: "session",
  messageID: "message",
  type: "text",
  preview: id,
  content: { version, bytes: 12 },
})
const page = (items: SessionPartSummary[]): SessionPartPage => ({
  items,
  nextCursor: "next",
  previousCursor: "previous",
  hasMore: true,
  hasEarlier: true,
})
const target = { sessionID: "session", messageID: "message" }

test("a forced refresh follows an older pending page and coalesces queued refreshes", async () => {
  const requests: ((result: { page: SessionPartPage; action: "apply" }) => void)[] = []
  let current: SessionPartPage | undefined
  const loader = createPartSummaryLoader({
    page: () => current,
    summaries: () => current?.items ?? [],
    read: async () =>
      new Promise((resolve) => {
        requests.push(resolve)
      }),
    apply: (_, result) => {
      current = result
    },
  })
  const signal = new AbortController().signal
  const first = loader.load(target, signal)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const refresh = loader.load({ ...target, force: true, partID: "a", version: "one" }, signal)
  const duplicate = loader.load({ ...target, force: true, partID: "a", version: "one" }, signal)
  expect(duplicate).toBe(refresh)
  requests[0]({ page: page([summary("a")]), action: "apply" })
  await first
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(requests).toHaveLength(2)
  requests[1]({ page: page([summary("a", "two")]), action: "apply" })
  await refresh
  expect(current?.items[0].content.version).toBe("two")
})

test("parallel conflicts share a refreshed message page when it advances both parts", async () => {
  let current = page([summary("a"), summary("b")])
  let reads = 0
  const loader = createPartSummaryLoader({
    page: () => current,
    summaries: () => current.items,
    read: async () => {
      reads++
      return { page: page([summary("a", "two"), summary("b", "two")]), action: "apply" }
    },
    apply: (_, result) => {
      current = result
    },
  })
  const signal = new AbortController().signal
  await Promise.all(["a", "b"].map((partID) => loader.load({ ...target, force: true, partID, version: "one" }, signal)))
  expect(reads).toBe(1)
})

test("targeted recovery merges by identity and preserves the loaded history cursors", () => {
  const previous = page([summary("earlier"), summary("a"), summary("later")])
  const incoming = {
    ...page([summary("a", "two")]),
    nextCursor: null,
    previousCursor: null,
    hasMore: false,
    hasEarlier: false,
  }
  const result = planPartSummaryPage(
    previous.items,
    previous,
    incoming,
    { ...target, force: true, partID: "a" },
    "apply",
  )
  expect(result.items.map((item) => [item.id, item.content.version])).toEqual([
    ["a", "two"],
    ["earlier", "one"],
    ["later", "one"],
  ])
  expect(result.page).toEqual({ nextCursor: "next", previousCursor: "previous", hasMore: true, hasEarlier: true })
  const preserved = planPartSummaryPage(
    previous.items,
    previous,
    incoming,
    { ...target, force: true, partID: "a" },
    "preserve",
  )
  expect(preserved.items.find((item) => item.id === "a")?.content.version).toBe("one")
})

test("a cancelled queued refresh never requests or applies a page", async () => {
  let finish!: (result: { page: SessionPartPage; action: "apply" }) => void
  let reads = 0
  let applied = 0
  const loader = createPartSummaryLoader({
    page: () => undefined,
    summaries: () => [],
    read: async () => {
      reads++
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    apply: () => {
      applied++
    },
  })
  const first = loader.load(target, new AbortController().signal)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const controller = new AbortController()
  const refresh = loader.load({ ...target, force: true }, controller.signal)
  controller.abort()
  finish({ page: page([summary("a")]), action: "apply" })
  await Promise.all([first, refresh])
  expect(reads).toBe(1)
  expect(applied).toBe(1)
})
