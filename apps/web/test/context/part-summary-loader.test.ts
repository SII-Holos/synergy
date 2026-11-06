import { expect, test } from "bun:test"
import type { SessionPartPage, SessionPartSummary } from "@ericsanchezok/synergy-sdk"
import {
  createPartSummaryLoader,
  partSummaryPageState,
  planPartSummaryPage,
  readPartSummaryRanges,
  type PartSummaryPageState,
  type PartSummaryWindow,
} from "../../src/context/part-summary-loader"

const summary = (id: string, version = "one"): SessionPartSummary => ({
  id,
  sessionID: "session",
  messageID: "message",
  type: "text",
  preview: id,
  content: { version, bytes: 12 },
})
const page = (items: SessionPartSummary[]): SessionPartPage & PartSummaryPageState => {
  const result = { items, nextCursor: "next", previousCursor: "previous", hasMore: true, hasEarlier: true }
  return { ...result, ...partSummaryPageState(result) }
}
const target = { sessionID: "session", messageID: "message" }

test("a forced refresh follows an older pending page and coalesces queued refreshes", async () => {
  const requests: ((result: { page: PartSummaryWindow; action: "apply" }) => void)[] = []
  let current: (SessionPartPage & PartSummaryPageState) | undefined
  const loader = createPartSummaryLoader({
    page: () => current,
    summaries: () => current?.items ?? [],
    read: async () =>
      new Promise((resolve) => {
        requests.push(resolve)
      }),
    apply: (_, result) => {
      current = { ...result, ...partSummaryPageState(result) }
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
      current = { ...result, ...partSummaryPageState(result) }
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
  expect(result.page).toMatchObject({ nextCursor: "next", previousCursor: "previous", hasMore: true, hasEarlier: true })
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
  let finish!: (result: { page: PartSummaryWindow; action: "apply" }) => void
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

test("a stale accepted window reloads instead of returning the warm page", async () => {
  const loaded = Array.from({ length: 230 }, (_, index) => summary(`part_${String(index).padStart(4, "0")}`))
  let current = { ...page(loaded), stale: true }
  let reads = 0
  const loader = createPartSummaryLoader({
    page: () => current,
    summaries: () => current.items,
    read: async () => {
      reads++
      return { page: page(loaded.map((part) => summary(part.id, "restored"))), action: "apply" }
    },
    apply: (request, result, action, refresh) => {
      const planned = planPartSummaryPage(current.items, current, result, request, action, refresh)
      current = { ...planned.page, items: planned.items, stale: false }
    },
  })
  await loader.load(target, new AbortController().signal)
  expect(reads).toBe(1)
  expect(current.items).toHaveLength(230)
  expect(current.items.at(-1)?.content.version).toBe("restored")
  expect(current.stale).toBe(false)
})

const partID = (index: number) => `part_${String(index).padStart(4, "0")}`
function storagePage(
  records: readonly SessionPartSummary[],
  query: { partID?: string; cursor?: string; older?: boolean; limit: number },
  bytePageLimit = 100,
): PartSummaryWindow {
  const descending = !!query.partID || !!query.older
  const ordered = records.filter((part) =>
    query.partID
      ? part.id <= query.partID
      : query.cursor
        ? descending
          ? part.id < query.cursor
          : part.id > query.cursor
        : true,
  )
  if (descending) ordered.reverse()
  const items = ordered.slice(0, Math.min(query.limit, bytePageLimit))
  if (descending) items.reverse()
  const firstID = items[0]?.id
  const lastID = items.at(-1)?.id
  const hasEarlier = !!firstID && records.some((part) => part.id < firstID)
  const hasMore = !!lastID && records.some((part) => part.id > lastID)
  const result = {
    items,
    hasMore,
    hasEarlier,
    previousCursor: hasEarlier ? firstID : null,
    nextCursor: hasMore ? lastID : null,
  }
  return { ...result, ranges: partSummaryPageState(result).ranges }
}

test("recovery atomically refreshes all admitted ranges without hydrating their gaps", async () => {
  const records = Array.from({ length: 600 }, (_, index) => summary(partID(index)))
  let current = {
    ...storagePage(records, { limit: 100 }),
    ...partSummaryPageState(storagePage(records, { limit: 100 })),
  }
  for (const [start, end] of [
    [100, 199],
    [200, 229],
    [480, 499],
  ]) {
    const request = start < 480 ? { ...target, more: true } : { ...target, force: true, partID: partID(end) }
    const result = planPartSummaryPage(
      current.items,
      current,
      storagePage(records, { partID: partID(end), limit: end - start + 1 }),
      request,
      "apply",
    )
    current = { ...result.page, items: result.items }
  }
  const cursors = {
    nextCursor: current.nextCursor,
    previousCursor: current.previousCursor,
    hasMore: current.hasMore,
    hasEarlier: current.hasEarlier,
  }
  const deleted = new Set([0, 99, 100, 199, 200, 229, 480, 499].map(partID))
  const authoritative = records.filter((part) => !deleted.has(part.id)).map((part) => summary(part.id, "restored"))
  const before = current.items
  let reads = 0
  let applications = 0
  current.stale = true
  const loader = createPartSummaryLoader({
    page: () => current,
    summaries: () => current.items,
    read: async (_request, _cursor, signal, refresh) => {
      expect(refresh).toBeDefined()
      const result = await readPartSummaryRanges({
        page: refresh!.page,
        accepted: refresh!.versions,
        signal,
        read: async (query) => {
          reads++
          expect(query.limit).toBeLessThanOrEqual(100)
          expect(current.items).toBe(before)
          return storagePage(authoritative, query, 23)
        },
      })
      return { page: result, action: "apply" }
    },
    apply: (request, result, action, refresh) => {
      applications++
      const planned = planPartSummaryPage(current.items, current, result, request, action, refresh)
      expect(planned.removedIDs.toSorted()).toEqual([...deleted].toSorted())
      current = { ...planned.page, items: planned.items }
    },
  })
  await loader.load(target, new AbortController().signal)
  expect(applications).toBe(1)
  expect(reads).toBe(13)
  expect(current.items).toHaveLength(242)
  expect(current.items.every((part) => part.content.version === "restored")).toBe(true)
  expect(current.items.some((part) => part.id >= partID(230) && part.id < partID(480))).toBe(false)
  expect(current).toMatchObject({ ...cursors, stale: false })
  expect(current.ranges).toHaveLength(4)
})

test("an accepted recovery preserves newer live writes and removals while removing missed parts", () => {
  const before = page([summary("a"), summary("b"), summary("c"), summary("d"), summary("e")])
  const live = [summary("a", "live"), summary("c"), summary("d"), summary("e"), summary("f", "live")]
  const refreshed = page([
    summary("a", "snapshot"),
    summary("b", "snapshot"),
    summary("c", "snapshot"),
    summary("e", "snapshot"),
  ])
  const planned = planPartSummaryPage(
    live,
    { ...before, stale: true },
    refreshed,
    { ...target, force: true },
    "preserve",
    {
      page: before,
      versions: new Map(before.items.map((part) => [part.id, part.content.version])),
    },
  )
  expect(planned.items.map((part) => [part.id, part.content.version])).toEqual([
    ["a", "live"],
    ["c", "snapshot"],
    ["e", "snapshot"],
    ["f", "live"],
  ])
  expect(planned.removedIDs).toEqual(["d"])
  expect(planned.page.stale).toBe(false)
})

test("recovery reads remain bounded when a transport returns a nonadvancing cursor", async () => {
  const state = { ...partSummaryPageState(page([summary("a"), summary("z")])), stale: true }
  let reads = 0
  await expect(
    readPartSummaryRanges({
      page: state,
      accepted: new Map([
        ["a", "one"],
        ["z", "one"],
      ]),
      signal: new AbortController().signal,
      read: async () => {
        reads++
        return { ...page([summary("z")]), previousCursor: "z" }
      },
    }),
  ).rejects.toThrow("Conversation summary changed while loading")
  expect(reads).toBe(2)
})

test("recovery discovers missed appends beyond a previously complete Part window", async () => {
  const initial = storagePage(
    ["a", "b", "c"].map((id) => summary(id)),
    { limit: 100 },
  )
  const authoritative = ["a", "b", "c", "d", "e"].map((id) => summary(id))
  const result = await readPartSummaryRanges({
    page: { ...partSummaryPageState(initial), stale: true },
    accepted: new Map(initial.items.map((part) => [part.id, part.content.version])),
    signal: new AbortController().signal,
    read: async (query) => storagePage(authoritative, query),
  })
  expect(result.items.map((item) => item.id)).toEqual(["a", "b", "c", "d", "e"])
  expect(result.hasMore).toBe(false)
})

test("recovery removes a missed deletion of an accepted live Part outside snapshot ranges", async () => {
  const initial = storagePage(
    ["a", "b", "c"].map((id) => summary(id)),
    { limit: 100 },
  )
  const before = { ...partSummaryPageState(initial), stale: true }
  const accepted = [...initial.items, summary("d")]
  const result = await readPartSummaryRanges({
    page: before,
    accepted: new Map(accepted.map((part) => [part.id, part.content.version])),
    signal: new AbortController().signal,
    read: async (query) => storagePage(initial.items, query),
  })
  const planned = planPartSummaryPage(accepted, before, result, target, "apply", {
    page: before,
    versions: new Map(accepted.map((part) => [part.id, part.content.version])),
  })
  expect(planned.items.map((item) => item.id)).toEqual(["a", "b", "c"])
  expect(planned.removedIDs).toEqual(["d"])
})

test("an empty accepted page retains and refreshes more than one page of live Parts", async () => {
  const initial = storagePage([], { limit: 100 })
  const accepted = Array.from({ length: 230 }, (_, index) => summary(partID(index)))
  const authoritative = accepted.filter((part) => part.id !== partID(120)).map((part) => summary(part.id, "restored"))
  const before = { ...partSummaryPageState(initial), stale: true }
  const versions = new Map(accepted.map((part) => [part.id, part.content.version]))
  const result = await readPartSummaryRanges({
    page: before,
    accepted: versions,
    signal: new AbortController().signal,
    read: async (query) => storagePage(authoritative, query),
  })
  const planned = planPartSummaryPage(accepted, before, result, target, "apply", { page: before, versions })
  expect(planned.items).toHaveLength(229)
  expect(planned.items.at(-1)?.content.version).toBe("restored")
  expect(planned.removedIDs).toEqual([partID(120)])
})

test("a newly discovered tail stays bounded and exposes the remaining cursor", async () => {
  const initial = storagePage(
    Array.from({ length: 3 }, (_, index) => summary(partID(index))),
    { limit: 100 },
  )
  const records = Array.from({ length: 250 }, (_, index) => summary(partID(index)))
  let reads = 0
  const result = await readPartSummaryRanges({
    page: partSummaryPageState(initial),
    accepted: new Map(initial.items.map((part) => [part.id, part.content.version])),
    signal: new AbortController().signal,
    read: async (query) => {
      reads++
      return storagePage(records, query)
    },
  })
  expect(result.items).toHaveLength(103)
  expect(result.nextCursor).toBe(partID(102))
  expect(result.hasMore).toBe(true)
  expect(reads).toBe(3)
})

test("a proven target tail discovers appends without admitting the main history gap", async () => {
  const records = Array.from({ length: 300 }, (_, index) => summary(partID(index)))
  const initial = storagePage(records, { limit: 100 })
  const before = planPartSummaryPage(
    initial.items,
    partSummaryPageState(initial),
    storagePage(records, { partID: partID(299), limit: 20 }),
    { ...target, force: true, partID: partID(299) },
    "apply",
  )
  const authoritative = Array.from({ length: 320 }, (_, index) => summary(partID(index))).filter(
    (part) => part.id !== partID(280) && part.id !== partID(299),
  )
  const result = await readPartSummaryRanges({
    page: before.page,
    accepted: new Map(before.items.map((part) => [part.id, part.content.version])),
    signal: new AbortController().signal,
    read: async (query) => storagePage(authoritative, query),
  })
  expect(result.items).toHaveLength(138)
  expect(result.items.at(-1)?.id).toBe(partID(319))
  expect(result.items.some((part) => part.id >= partID(100) && part.id < partID(280))).toBe(false)
  expect(result.nextCursor).toBe(partID(99))
  expect(result.hasMore).toBe(true)
})

test("an invalid targeted page cannot leave uncovered live refresh spinning", async () => {
  const initial = storagePage([summary("a")], { limit: 100 })
  let reads = 0
  await expect(
    readPartSummaryRanges({
      page: partSummaryPageState(initial),
      accepted: new Map([
        ["a", "one"],
        ["d", "one"],
      ]),
      signal: new AbortController().signal,
      read: async (query) => {
        reads++
        return query.partID === "d" ? storagePage([summary("z")], { limit: 100 }) : initial
      },
    }),
  ).rejects.toThrow("Conversation summary changed while loading")
  expect(reads).toBe(2)
})

test("loading earlier Parts preserves a complete main tail with a null forward cursor", () => {
  const records = Array.from({ length: 200 }, (_, index) => summary(partID(index)))
  const current = storagePage(records, { partID: partID(199), limit: 100 })
  const earlier = storagePage(records, { cursor: partID(100), older: true, limit: 100 })
  const planned = planPartSummaryPage(
    current.items,
    partSummaryPageState(current),
    earlier,
    { ...target, more: true, older: true },
    "apply",
  )
  expect(planned.page.hasMore).toBe(false)
  expect(planned.page.nextCursor).toBeNull()
  expect(planned.page.previousCursor).toBeNull()
})
