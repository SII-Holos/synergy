import { describe, expect, test } from "bun:test"
import {
  applyLatestPage,
  prependOlderPage,
  reconcileMessage,
  removeMessageFromWindow,
  DEFAULT_CAP,
  compareByTimeThenId,
  type MessageRef,
  type MessageWindowState,
} from "../../src/context/session-message-window"

// ---------------------------------------------------------------------------
// Small structural message fixtures — keep the module generic, not tied to SDK
// ---------------------------------------------------------------------------

const msg = (id: string, created: number): MessageRef => ({
  id,
  time: { created },
})

const root = (id: string, created: number): MessageRef => msg(id, created)

const window = (messages: MessageRef[], overrides?: Partial<MessageWindowState>): MessageWindowState => ({
  messages,
  mode: "latest",
  pendingLatest: false,
  pendingLatestIds: [],
  ...overrides,
})

// ---------------------------------------------------------------------------
// applyLatestPage
// ---------------------------------------------------------------------------

describe("applyLatestPage", () => {
  test("preserves server canonical order", () => {
    const server = [msg("c", 3), msg("b", 2), msg("a", 1)]
    const result = applyLatestPage(server)
    expect(result.window.messages.map((m) => m.id)).toEqual(["a", "b", "c"])
    expect(result.window.mode).toBe("latest")
    expect(result.window.pendingLatest).toBe(false)
    expect(result.droppedIds).toEqual([])
  })

  test("merges referenced roots without duplication", () => {
    // Server has messages b and c; root_b duplicates server b by id; root_d is
    // a dependency-only message.
    const server = [msg("c", 3), msg("b", 2)]
    const roots = [root("b", 2), root("d", 4)]
    const result = applyLatestPage(server, roots)
    // Canonical order: a=1 missing; b=2, c=3, d=4. b should not appear twice.
    expect(result.window.messages.map((m) => m.id)).toEqual(["b", "c", "d"])
    expect(result.droppedIds).toEqual([])
  })

  test("caps to DEFAULT_CAP newest messages and reports oldest dropped", () => {
    const cap = 3
    // 5 messages: oldest a=1 through newest e=5
    const server = [msg("a", 1), msg("b", 2), msg("c", 3), msg("d", 4), msg("e", 5)]
    const result = applyLatestPage(server, undefined, cap)
    expect(result.window.messages.map((m) => m.id)).toEqual(["c", "d", "e"])
    expect(result.droppedIds).toEqual(["a", "b"])
  })

  test("referenced roots count against the cap — excess drops oldest refs too", () => {
    const cap = 3
    const server = [msg("a", 1), msg("b", 2)]
    const roots = [root("c", 3), root("d", 4)] // d is newest
    const result = applyLatestPage(server, roots, cap)
    // Canonical: a=1, b=2, c=3, d=4 — cap 3 keeps b,c,d, drops a
    expect(result.window.messages.map((m) => m.id)).toEqual(["b", "c", "d"])
    expect(result.droppedIds).toEqual(["a"])
  })

  test("empty input produces empty window", () => {
    const result = applyLatestPage([])
    expect(result.window.messages).toEqual([])
    expect(result.droppedIds).toEqual([])
  })

  test("referenced roots are included as dependencies, not as primary page markers", () => {
    // Roots contribute messages but the mode reset makes them part of the
    // overall latest window — they don't form a separate cursor boundary.
    const server = [msg("m1", 10)]
    const roots = [root("r1", 5)]
    const result = applyLatestPage(server, roots)
    // Both are present; window mode is latest (not a separate root marker).
    expect(result.window.messages.map((m) => m.id)).toContain("m1")
    expect(result.window.messages.map((m) => m.id)).toContain("r1")
    expect(result.window.mode).toBe("latest")
  })
})

// ---------------------------------------------------------------------------
// prependOlderPage
// ---------------------------------------------------------------------------

describe("prependOlderPage", () => {
  test("deduplicates by ID — older message already in window is skipped", () => {
    const current = window([msg("c", 3), msg("d", 4)], { mode: "history" })
    const older = [msg("a", 1), msg("b", 2), msg("c", 3)] // c duplicates
    const result = prependOlderPage(current, older)
    expect(result.window.messages.map((m) => m.id)).toEqual(["a", "b", "c", "d"])
    expect(result.droppedIds).toEqual([])
  })

  test("preserves canonical order — does not lexicographically sort by ID", () => {
    // Lexicographic sort by id: b, c, d. But canonical order is by time.created
    // then id. Here d has created=4 (newer than c=3, b=2). So canonical: b, c, d.
    // Crucially it's NOT "a, b, c" just because id letters sort that way.
    const current = window([msg("d", 4)], { mode: "history" })
    const older = [msg("c", 3), msg("b", 2)]
    const result = prependOlderPage(current, older)
    // Canonical = b(2), c(3), d(4)
    expect(result.window.messages.map((m) => m.id)).toEqual(["b", "c", "d"])
  })

  test("caps by evicting newest primary items, preserving the loaded oldest page", () => {
    const cap = 3
    // Existing window (newer): d=4, e=5, f=6
    // Older page being loaded: a=1, b=2, c=3
    const current = window([msg("d", 4), msg("e", 5), msg("f", 6)], { mode: "history" })
    const older = [msg("a", 1), msg("b", 2), msg("c", 3)]
    const result = prependOlderPage(current, older, cap)
    // Combined: a=1, b=2, c=3, d=4, e=5, f=6 (6 items, cap 3)
    // Evict newest: f, e, d are evicted. Keep oldest: a, b, c.
    expect(result.window.messages.map((m) => m.id)).toEqual(["a", "b", "c"])
    // f, e, d dropped (newest evicted first, in that order)
    expect(result.droppedIds).toEqual(["d", "e", "f"])
  })

  test("keeps mode as history after prepend", () => {
    const current = window([msg("b", 2)], { mode: "history" })
    const result = prependOlderPage(current, [msg("a", 1)])
    expect(result.window.mode).toBe("history")
  })

  test("reports dropped IDs when cap is below combined size", () => {
    const cap = 2
    const current = window([msg("c", 3), msg("d", 4)], { mode: "history" })
    const older = [msg("a", 1), msg("b", 2)]
    const result = prependOlderPage(current, older, cap)
    // Combined 4 items, cap 2, keep oldest 2: a, b. Drop newest: c, d.
    expect(result.window.messages.map((m) => m.id)).toEqual(["a", "b"])
    expect(result.droppedIds).toEqual(["c", "d"])
  })
  test("clears pending IDs that become visible in the loaded page", () => {
    const current = window([msg("visible", 3)], {
      mode: "history",
      pendingLatest: true,
      pendingLatestIds: ["older"],
    })
    const result = prependOlderPage(current, [msg("older", 1)])

    expect(result.window.pendingLatest).toBe(false)
    expect(result.window.pendingLatestIds).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// reconcileMessage — latest mode
// ---------------------------------------------------------------------------

describe("reconcileMessage in latest mode", () => {
  test("inserts a newer message in correct canonical position", () => {
    const w = window([msg("a", 1), msg("c", 3)])
    const result = reconcileMessage(w, msg("b", 2))
    expect(result.window.messages.map((m) => m.id)).toEqual(["a", "b", "c"])
    expect(result.window.mode).toBe("latest")
  })

  test("inserts an older message in correct canonical position", () => {
    const w = window([msg("b", 2), msg("c", 3)])
    const result = reconcileMessage(w, msg("a", 1))
    expect(result.window.messages.map((m) => m.id)).toEqual(["a", "b", "c"])
  })

  test("uses id tiebreaker when time.created is the same", () => {
    const w = window([msg("a", 1), msg("b", 1)]) // same created=1
    // a < b lexicographically, so inserting c(=1) should go between a and b
    const result = reconcileMessage(w, msg("c", 1))
    expect(result.window.messages.map((m) => m.id)).toEqual(["a", "b", "c"])
  })

  test("reconciles (replaces) an existing message with updated data", () => {
    const w = window([msg("a", 1), msg("b", 2)])
    // Update message "a" — bump its created time
    const result = reconcileMessage(w, msg("a", 5))
    expect(result.window.messages.map((m) => m.id)).toEqual(["b", "a"])
    expect(result.window.messages.find((m) => m.id === "a")!.time.created).toBe(5)
  })

  test("evicts oldest when over cap after insert", () => {
    const cap = 3
    const w = window([msg("b", 2), msg("c", 3), msg("d", 4)])
    const result = reconcileMessage(w, msg("a", 1), cap)
    // Insert a=1 at front → a,b,c,d (4 items, cap 3). Evict oldest: a.
    expect(result.window.messages.map((m) => m.id)).toEqual(["b", "c", "d"])
    expect(result.droppedIds).toEqual(["a"])
  })

  test("reports no dropped IDs when under cap", () => {
    const w = window([msg("a", 1)])
    const result = reconcileMessage(w, msg("b", 2))
    expect(result.droppedIds).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// reconcileMessage — history mode
// ---------------------------------------------------------------------------

describe("reconcileMessage in history mode", () => {
  test("does not insert an ID outside the current history window", () => {
    const w = window([msg("b", 2), msg("c", 3)], { mode: "history" })
    const result = reconcileMessage(w, msg("d", 4))
    // d is newer than anything in the window — outside history range
    expect(result.window.messages.map((m) => m.id)).toEqual(["b", "c"])
    expect(result.window.pendingLatest).toBe(true)
    expect(result.droppedIds).toEqual([])
  })

  test("sets pendingLatest to true when outside-window update arrives", () => {
    const w = window([msg("a", 1)], { mode: "history", pendingLatest: false })
    const result = reconcileMessage(w, msg("z", 99))
    expect(result.window.pendingLatest).toBe(true)
  })

  test("deduplicates repeated updates for the same pending message", () => {
    const first = reconcileMessage(window([msg("a", 1)], { mode: "history" }), msg("z", 99))
    const repeated = reconcileMessage(first.window, msg("z", 99))

    expect(repeated.window.pendingLatestIds).toEqual(["z"])
  })

  test("maintains existing pendingLatest=true (does not reset it)", () => {
    const w = window([msg("a", 1)], { mode: "history", pendingLatest: true })
    const result = reconcileMessage(w, msg("z", 99))
    expect(result.window.pendingLatest).toBe(true)
  })

  test("reconciles an already-loaded ID normally in history mode", () => {
    const w = window([msg("a", 1), msg("b", 2)], { mode: "history" })
    // Update existing message "a" with new time
    const result = reconcileMessage(w, msg("a", 3))
    expect(result.window.messages.map((m) => m.id)).toEqual(["b", "a"])
    expect(result.window.messages.find((m) => m.id === "a")!.time.created).toBe(3)
    // Mode and pending unchanged — we are still in history
    expect(result.window.mode).toBe("history")
    expect(result.window.pendingLatest).toBe(false)
  })

  test("does not evict in history mode on inside-window reconcile", () => {
    const cap = 2
    const w = window([msg("a", 1), msg("b", 2)], { mode: "history" })
    const result = reconcileMessage(w, msg("a", 5), cap)
    // a updates but is already in window; cap unchanged, no eviction needed
    expect(result.window.messages.map((m) => m.id)).toEqual(["b", "a"])
    expect(result.droppedIds).toEqual([])
  })
})

describe("removeMessageFromWindow", () => {
  test("clears the pending notice when its unseen live arrival is removed", () => {
    const current = window([msg("a", 1)], {
      mode: "history",
      pendingLatest: true,
      pendingLatestIds: ["new"],
    })
    const result = removeMessageFromWindow(current, "new")

    expect(result.messages.map((message) => message.id)).toEqual(["a"])
    expect(result.pendingLatest).toBe(false)
    expect(result.pendingLatestIds).toEqual([])
  })

  test("keeps the notice while another unseen live arrival remains", () => {
    const current = window([msg("a", 1)], {
      mode: "history",
      pendingLatest: true,
      pendingLatestIds: ["new-1", "new-2"],
    })
    const result = removeMessageFromWindow(current, "new-1")

    expect(result.pendingLatest).toBe(true)
    expect(result.pendingLatestIds).toEqual(["new-2"])
  })

  test("removes a visible message without clearing unrelated pending arrivals", () => {
    const current = window([msg("visible", 1)], {
      mode: "history",
      pendingLatest: true,
      pendingLatestIds: ["new"],
    })
    const result = removeMessageFromWindow(current, "visible")

    expect(result.messages).toEqual([])
    expect(result.pendingLatest).toBe(true)
    expect(result.pendingLatestIds).toEqual(["new"])
  })
})

// ---------------------------------------------------------------------------
// compareByTimeThenId
// ---------------------------------------------------------------------------

describe("compareByTimeThenId", () => {
  test("orders by time.created ascending", () => {
    const sorted = [msg("b", 3), msg("a", 1), msg("c", 2)].toSorted(compareByTimeThenId)
    expect(sorted.map((m) => m.id)).toEqual(["a", "c", "b"])
  })

  test("breaks ties with id comparison", () => {
    const sorted = [msg("c", 1), msg("a", 1), msg("b", 1)].toSorted(compareByTimeThenId)
    expect(sorted.map((m) => m.id)).toEqual(["a", "b", "c"])
  })

  test("handles mixed time/created and id ordering", () => {
    const items = [
      msg("b", 2),
      msg("a", 1),
      msg("d", 2), // same time as b, tiebreak: d > b
      msg("c", 1), // same time as a, tiebreak: c > a
    ]
    const sorted = items.toSorted(compareByTimeThenId)
    expect(sorted.map((m) => m.id)).toEqual(["a", "c", "b", "d"])
  })
})

// ---------------------------------------------------------------------------
// DEFAULT_CAP
// ---------------------------------------------------------------------------

test("DEFAULT_CAP is 500", () => {
  expect(DEFAULT_CAP).toBe(500)
})
