import { describe, expect, test } from "bun:test"
import {
  computeBoardPanes,
  reorderPinnedKeys,
  splitPaneKey,
  type BoardPaneSource,
} from "../../../../src/components/kanban/model/pane-selection"

function entry(id: string, lastActivityAt: number, pinned = 0) {
  return {
    id,
    scopeID: "scope-1",
    scopeType: "project" as const,
    title: `Session ${id}`,
    category: "project" as const,
    lastActivityAt,
    pinned,
    archived: false,
    completionNotice: { unread: false, unreadCount: 0 },
  }
}

function source(scopeKey: string, id: string, lastActivityAt: number): BoardPaneSource {
  return { scopeKey, entry: entry(id, lastActivityAt) }
}

describe("computeBoardPanes", () => {
  test("pinned panes come first in pinned order, then sources fill the rest", () => {
    const sources = [source("/a", "s2", 10), source("/a", "s1", 20), source("/a", "s3", 30)]
    const panes = computeBoardPanes({ pinned: ["/a\ns2", "/a\ns1"], sources })
    expect(panes.map((p) => p.sessionID)).toEqual(["s2", "s1", "s3"])
    expect(panes.map((p) => p.pinned)).toEqual([true, true, false])
    expect(panes.every((p) => p.kind === "live")).toBe(true)
  })

  test("remaining slots fill in the given (sidebar recent) order", () => {
    const sources = [source("/a", "s1", 100), source("/a", "s2", 200), source("/a", "s3", 300), source("/a", "s4", 400)]
    const panes = computeBoardPanes({ pinned: ["/a\ns2"], sources })
    expect(panes.map((p) => p.sessionID)).toEqual(["s2", "s1", "s3", "s4"])
    expect(panes.map((p) => p.pinned)).toEqual([true, false, false, false])
  })

  test("idle sessions participate when slots remain", () => {
    const sources = [source("/a", "s1", 200), source("/a", "s2", 100)]
    const panes = computeBoardPanes({ pinned: [], sources })
    expect(panes.map((p) => p.sessionID)).toEqual(["s1", "s2"])
  })

  test("a leftover pinned key whose session vanished becomes an unavailable pane", () => {
    const sources = [source("/a", "s1", 100)]
    const panes = computeBoardPanes({ pinned: ["/a\ngone", "/a\ns1"], sources })
    expect(panes[0]).toMatchObject({ key: "/a\ngone", sessionID: "gone", kind: "unavailable", pinned: true })
    expect(panes[1]).toMatchObject({ sessionID: "s1", kind: "live", pinned: true })
  })

  test("respects the cap and does not duplicate pinned + auto", () => {
    const sources = [
      source("/a", "s1", 100),
      source("/a", "s2", 90),
      source("/a", "s3", 80),
      source("/a", "s4", 70),
      source("/a", "s5", 60),
      source("/a", "s6", 50),
      source("/a", "s7", 40),
    ]
    const panes = computeBoardPanes({ pinned: ["/a\ns3", "/a\ns7"], sources, cap: 4 })
    expect(panes).toHaveLength(4)
    expect(panes.map((p) => p.sessionID)).toEqual(["s3", "s7", "s1", "s2"])
    const ids = panes.map((p) => p.key)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("splitPaneKey parses the scope/session separator", () => {
    expect(splitPaneKey("/workspace/project\nses_1")).toEqual({ scopeKey: "/workspace/project", sessionID: "ses_1" })
    expect(splitPaneKey("naked")).toEqual({ scopeKey: "", sessionID: "naked" })
  })
})

describe("reorderPinnedKeys", () => {
  test("moves the dragged key onto the target position", () => {
    expect(reorderPinnedKeys(["/a\ns1", "/a\ns2", "/a\ns3"], "/a\ns1", "/a\ns3")).toEqual([
      "/a\ns2",
      "/a\ns3",
      "/a\ns1",
    ])
    expect(reorderPinnedKeys(["/a\ns1", "/a\ns2", "/a\ns3"], "/a\ns3", "/a\ns1")).toEqual([
      "/a\ns3",
      "/a\ns1",
      "/a\ns2",
    ])
  })

  test("returns the same array for unknown or equal keys", () => {
    expect(reorderPinnedKeys(["/a\ns1", "/a\ns2"], "/a\ns1", "/a\ns1")).toEqual(["/a\ns1", "/a\ns2"])
    expect(reorderPinnedKeys(["/a\ns1", "/a\ns2"], "/a\nmissing", "/a\ns1")).toEqual(["/a\ns1", "/a\ns2"])
  })
})
