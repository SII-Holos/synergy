import { expect, test } from "bun:test"
import { createSessionTagFilter, type TagFilterState } from "../../../src/components/sidebar/session-tag-filter"
import type { NavEntry, NavListState } from "../../../src/context/layout"

function entry(id: string): NavEntry {
  return {
    id,
    scopeID: "home",
    scopeType: "home",
    title: id,
    category: "home",
    tags: ["focus"],
    lastActivityAt: 1,
    pinned: 0,
    archived: false,
    completionNotice: { unread: false, unreadCount: 0 },
  }
}
const page = (id: string): NavListState => ({ items: [entry(id)], total: 1, nextCursor: null })

test("tag pages query all history and changing the query fences late replies and cursors", async () => {
  let state: TagFilterState | undefined
  const late = Promise.withResolvers<NavListState>()
  const requests: Array<{ tag: string; cursor?: unknown; signal: AbortSignal }> = []
  const filter = createSessionTagFilter({
    publish: (value) => {
      state = value
    },
    fetch: async (input) => {
      requests.push(input)
      if (input.tag === "old") return late.promise
      return input.cursor
        ? page("older-match")
        : { ...page("match"), total: 2, nextCursor: { id: "match", lastActivityAt: 1 } }
    },
  })
  const old = filter.select("old")
  await filter.select("focus")
  expect(requests[0].signal.aborted).toBe(true)
  expect(state?.items.map((row) => row.id)).toEqual(["match"])
  await filter.more()
  expect(state?.items.map((row) => row.id)).toEqual(["match", "older-match"])
  expect(requests[2].cursor).toEqual({ id: "match", lastActivityAt: 1 })
  late.resolve(page("stale"))
  await old
  expect(state?.items.map((row) => row.id)).toEqual(["match", "older-match"])
  await filter.select(undefined)
  expect(state?.items).toEqual([])
  expect(state?.nextCursor).toBeNull()
  filter.dispose()
})

test("tag requests expose failure and retry, reconcile metadata, and ignore disposed requests", async () => {
  let state: TagFilterState | undefined
  let fail = true
  const filter = createSessionTagFilter({
    publish: (value) => {
      state = value
    },
    fetch: async () => {
      if (fail) throw new Error("offline")
      return page("match")
    },
  })
  await filter.select("focus")
  expect(state?.error).toBe("offline")
  fail = false
  await filter.refresh()
  expect(state?.error).toBeUndefined()
  filter.update({ ...entry("match"), tags: [] })
  expect(state?.items).toEqual([])
  const pending = Promise.withResolvers<NavListState>()
  const disposed = createSessionTagFilter({
    fetch: () => pending.promise,
    publish: (value) => {
      state = value
    },
  })
  const loading = disposed.select("focus")
  disposed.dispose()
  pending.resolve(page("after-disposal"))
  await loading
  expect(state?.items).toEqual([])
})

test("metadata events remain authoritative over an older query response", async () => {
  let state: TagFilterState | undefined
  const response = Promise.withResolvers<NavListState>()
  const filter = createSessionTagFilter({
    fetch: () => response.promise,
    publish: (value) => {
      state = value
    },
  })
  const loading = filter.select("focus")
  filter.update({ ...entry("match"), tags: [] })
  filter.update(entry("new-match"))
  response.resolve(page("match"))
  await loading
  expect(state?.items.map((row) => row.id)).toEqual(["new-match"])
  filter.dispose()
})
