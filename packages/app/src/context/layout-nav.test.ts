import { describe, expect, test } from "bun:test"
import type { NavEntry, NavListState } from "./layout"
import { mergeNavListByID, orderNavEntries } from "./layout-nav"

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
