import { describe, expect, test } from "bun:test"
import type { NavEntry, NavListState } from "./layout"
import { applySessionToNavList, mergeNavListByID, navUpdateFromSession, orderNavEntries } from "./layout-nav"

function entry(input: Partial<NavEntry> & Pick<NavEntry, "id">): NavEntry {
  return {
    id: input.id,
    scopeID: input.scopeID ?? "scope",
    scopeType: input.scopeType ?? "project",
    title: input.title ?? input.id,
    category: input.category ?? "project",
    lastActivityAt: input.lastActivityAt ?? 0,
    pinned: input.pinned ?? 0,
    archived: input.archived ?? false,
    completionNotice: input.completionNotice ?? { unread: false },
  }
}

function list(items: NavEntry[]): NavListState {
  return { items, nextCursor: null, total: items.length }
}

describe("orderNavEntries", () => {
  test("orders pinned entries first, then by activity and id", () => {
    const pinnedEarly = entry({ id: "pinned-early", pinned: 10, lastActivityAt: 1 })
    const pinnedLate = entry({ id: "pinned-late", pinned: 20, lastActivityAt: 1 })
    const activeA = entry({ id: "a", lastActivityAt: 10 })
    const activeB = entry({ id: "b", lastActivityAt: 10 })
    const stale = entry({ id: "stale", lastActivityAt: 1 })

    expect(orderNavEntries([stale, activeA, pinnedEarly, activeB, pinnedLate]).map((item) => item.id)).toEqual([
      "pinned-late",
      "pinned-early",
      "b",
      "a",
      "stale",
    ])
  })
})

describe("mergeNavListByID", () => {
  test("updates existing nav rows by id while applying refreshed fields", () => {
    const previous = entry({ id: "session", title: "Old title", completionNotice: { unread: true }, lastActivityAt: 1 })
    const next = entry({ id: "session", title: "New title", lastActivityAt: 20 })

    const merged = mergeNavListByID(list([previous]), list([next]))

    expect(merged.items).toHaveLength(1)
    expect(merged.items[0]).toEqual({ ...previous, ...next })
    expect(merged.items[0].title).toBe("New title")
    expect(merged.items[0].completionNotice.unread).toBe(false)
  })

  test("keeps the server-provided order and removes missing entries", () => {
    const previousA = entry({ id: "a" })
    const previousB = entry({ id: "b" })
    const nextB = entry({ id: "b", lastActivityAt: 5 })
    const nextC = entry({ id: "c", lastActivityAt: 4 })

    const merged = mergeNavListByID(list([previousA, previousB]), list([nextB, nextC]))

    expect(merged.items.map((item) => item.id)).toEqual(["b", "c"])
    expect(merged.total).toBe(2)
  })
})

describe("navUpdateFromSession", () => {
  test("projects nav-relevant fields from a session info", () => {
    const u = navUpdateFromSession({
      id: "s1",
      title: "Hello",
      pinned: 3,
      parentID: "p1",
      time: { updated: 1234, archived: 0 },
      completionNotice: { unread: true },
    })
    expect(u).toEqual({
      id: "s1",
      title: "Hello",
      pinned: 3,
      lastActivityAt: 1234,
      archived: false,
      parentID: "p1",
      completionNoticeUnread: true,
    })
  })

  test("marks archived when time.archived is set", () => {
    expect(navUpdateFromSession({ id: "s1", time: { archived: 999 } }).archived).toBe(true)
  })
})

describe("applySessionToNavList", () => {
  test("returns applied=false when the session is not in the list", () => {
    const l = list([entry({ id: "a" })])
    const r = applySessionToNavList(l, navUpdateFromSession({ id: "missing", time: { updated: 5 } }))
    expect(r.applied).toBe(false)
    expect(r.list).toBe(l)
  })

  test("updates title/pin/activity in place for an existing entry", () => {
    const l = list([entry({ id: "a", title: "old", lastActivityAt: 1 }), entry({ id: "b" })])
    const r = applySessionToNavList(
      l,
      navUpdateFromSession({ id: "a", title: "new", pinned: 7, time: { updated: 99 } }),
    )
    expect(r.applied).toBe(true)
    const updated = r.list.items.find((e) => e.id === "a")!
    expect(updated.title).toBe("new")
    expect(updated.pinned).toBe(7)
    expect(updated.lastActivityAt).toBe(99)
    // updating lastActivityAt in place is enough — orderNavEntries reorders at read
    expect(orderNavEntries(r.list.items).map((e) => e.id)).toEqual(["a", "b"])
  })

  test("removes an archived entry and decrements total", () => {
    const l = list([entry({ id: "a" }), entry({ id: "b" })])
    const r = applySessionToNavList(l, navUpdateFromSession({ id: "a", time: { archived: 1 } }))
    expect(r.applied).toBe(true)
    expect(r.list.items.map((e) => e.id)).toEqual(["b"])
    expect(r.list.total).toBe(1)
  })

  test("preserves prior fields when the update omits them", () => {
    const l = list([entry({ id: "a", title: "keep", pinned: 2, completionNotice: { unread: true } })])
    const r = applySessionToNavList(l, { id: "a", archived: false, lastActivityAt: 50 })
    const updated = r.list.items[0]
    expect(updated.title).toBe("keep")
    expect(updated.pinned).toBe(2)
    expect(updated.completionNotice.unread).toBe(true)
    expect(updated.lastActivityAt).toBe(50)
  })
})
