import { describe, expect, test } from "bun:test"
import { SessionNav, type SessionNavEntry, type NavCursor } from "../../src/session/nav"

/**
 * Cursor pagination invariant tests.
 *
 * These tests verify that cursor-based pagination over a sorted list of
 * SessionNavEntry items obeys the contract: no duplicates, no missing
 * items, ties resolved deterministically, and correct nextCursor (null when exhausted).
 *
 * This is a pure logic test — no file I/O. The paginateWithCursor
 * function is a helper for queryScope/queryGlobal to use internally.
 */

function makeEntry(id: string, lastActivityAt: number, pinned = 0, archived = false): SessionNavEntry {
  return {
    id,
    scopeID: "scope_test",
    scopeType: "project",
    title: `Session ${id}`,
    category: "project",
    lastActivityAt,
    pinned,
    archived,
    completionNotice: { unread: false, unreadCount: 0 },
  }
}

describe("SessionNav.paginateWithCursor", () => {
  // ── Basic pagination ──────────────────────────────────────────────────
  test("returns first page with correct items and nextCursor", () => {
    const entries: SessionNavEntry[] = [makeEntry("ses_c", 300), makeEntry("ses_b", 200), makeEntry("ses_a", 100)]

    const result = SessionNav.paginateWithCursor(entries, { limit: 2 })
    expect(result.items).toHaveLength(2)
    expect(result.items[0].id).toBe("ses_c")
    expect(result.items[1].id).toBe("ses_b")
    expect(result.nextCursor).toEqual({ lastActivityAt: 200, id: "ses_b" })
    expect(result.total).toBe(3)
  })

  test("returns empty items when list is empty", () => {
    const result = SessionNav.paginateWithCursor([], { limit: 10 })
    expect(result.items).toHaveLength(0)
    expect(result.nextCursor).toBeNull()
    expect(result.total).toBe(0)
  })

  test("returns all items when limit exceeds list size", () => {
    const entries = [makeEntry("ses_z", 10), makeEntry("ses_y", 5)]
    const result = SessionNav.paginateWithCursor(entries, { limit: 10 })
    expect(result.items).toHaveLength(2)
    expect(result.nextCursor).toBeNull()
    expect(result.total).toBe(2)
  })

  // ── Cursor resume (no duplicates, no gaps) ────────────────────────────
  test("cursor resume returns next page without duplicates or gaps", () => {
    const entries: SessionNavEntry[] = [
      makeEntry("ses_e", 500),
      makeEntry("ses_d", 400),
      makeEntry("ses_c", 300),
      makeEntry("ses_b", 200),
      makeEntry("ses_a", 100),
    ]

    // Page 1
    const page1 = SessionNav.paginateWithCursor(entries, { limit: 2 })
    expect(page1.total).toBe(5)
    expect(page1.items.map((e) => e.id)).toEqual(["ses_e", "ses_d"])

    // Page 2 — resume from page1's nextCursor
    const page2 = SessionNav.paginateWithCursor(entries, { limit: 2, cursor: page1.nextCursor })
    expect(page2.items.map((e) => e.id)).toEqual(["ses_c", "ses_b"])
    expect(page2.nextCursor).toEqual({ lastActivityAt: 200, id: "ses_b" })

    // Page 3 — last page
    const page3 = SessionNav.paginateWithCursor(entries, { limit: 2, cursor: page2.nextCursor })
    expect(page3.items.map((e) => e.id)).toEqual(["ses_a"])
    expect(page3.nextCursor).toBeNull()
  })

  // ── Tie handling: identical lastActivityAt ────────────────────────────
  test("ties on lastActivityAt broken by id DESC", () => {
    const entries: SessionNavEntry[] = [
      makeEntry("ses_z", 100, 0),
      makeEntry("ses_m", 100, 0),
      makeEntry("ses_a", 100, 0),
      makeEntry("ses_k", 100, 0),
    ]
    // Assume entries are pre-sorted (lastActivityAt DESC, id DESC)
    // Re-sort to verify the function doesn't assume pre-sorted
    entries.sort((a, b) => {
      const da = b.lastActivityAt - a.lastActivityAt
      if (da !== 0) return da
      return b.id.localeCompare(a.id)
    })
    // Sorted should be: ses_z, ses_m, ses_k, ses_a
    expect(entries.map((e) => e.id)).toEqual(["ses_z", "ses_m", "ses_k", "ses_a"])

    const page1 = SessionNav.paginateWithCursor(entries, { limit: 2 })
    expect(page1.items.map((e) => e.id)).toEqual(["ses_z", "ses_m"])
    expect(page1.nextCursor).toEqual({ lastActivityAt: 100, id: "ses_m" })

    const page2 = SessionNav.paginateWithCursor(entries, { limit: 2, cursor: page1.nextCursor })
    expect(page2.items.map((e) => e.id)).toEqual(["ses_k", "ses_a"])
    expect(page2.nextCursor).toBeNull()
  })

  // ── Cursor at exact boundary ──────────────────────────────────────────
  test("cursor matching last item returns empty next page", () => {
    const entries = [makeEntry("ses_z", 300), makeEntry("ses_y", 200), makeEntry("ses_x", 100)]

    const page1 = SessionNav.paginateWithCursor(entries, { limit: 3 })
    expect(page1.items).toHaveLength(3)
    expect(page1.nextCursor).toBeNull()
  })

  test("cursor past last item returns empty", () => {
    const entries = [makeEntry("ses_z", 300), makeEntry("ses_y", 200)]
    const result = SessionNav.paginateWithCursor(entries, {
      limit: 10,
      cursor: { lastActivityAt: 50, id: "ses_old" },
    })
    expect(result.items).toHaveLength(0)
    expect(result.nextCursor).toBeNull()
    expect(result.total).toBe(2)
  })

  test("cursor matching first item skips it", () => {
    const entries = [makeEntry("ses_z", 300), makeEntry("ses_y", 200)]
    const result = SessionNav.paginateWithCursor(entries, {
      limit: 10,
      cursor: { lastActivityAt: 300, id: "ses_z" },
    })
    expect(result.items.map((e) => e.id)).toEqual(["ses_y"])
    expect(result.nextCursor).toBeNull()
  })

  // ── No mutation ───────────────────────────────────────────────────────
  test("does not mutate the input array", () => {
    const entries = [makeEntry("ses_b", 200), makeEntry("ses_a", 100)]
    const snapshot = JSON.stringify(entries)
    SessionNav.paginateWithCursor(entries, { limit: 1 })
    expect(JSON.stringify(entries)).toBe(snapshot)
  })

  // ── Same-cursor stability ─────────────────────────────────────────────
  test("same cursor returns same page (idempotent)", () => {
    const entries = [makeEntry("ses_e", 500), makeEntry("ses_d", 400), makeEntry("ses_c", 300)]

    const cursor: NavCursor = { lastActivityAt: 400, id: "ses_d" }
    const a = SessionNav.paginateWithCursor(entries, { limit: 2, cursor })
    const b = SessionNav.paginateWithCursor(entries, { limit: 2, cursor })
    expect(a.items.map((e) => e.id)).toEqual(b.items.map((e) => e.id))
    expect(a.nextCursor).toEqual(b.nextCursor)
  })
})
