import { describe, expect, test } from "bun:test"
import {
  computeBoardPanes,
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

function source(
  scopeKey: string,
  id: string,
  lastActivityAt: number,
  running: boolean,
  waiting: boolean,
): BoardPaneSource {
  return { scopeKey, entry: entry(id, lastActivityAt), running, waiting }
}

describe("computeBoardPanes", () => {
  test("pinned panes come first in pinned order", () => {
    const sources = [
      source("/a", "s2", 10, true, false),
      source("/a", "s1", 20, true, false),
      source("/a", "s3", 30, false, false),
    ]
    const panes = computeBoardPanes({ pinned: ["/a\ns2", "/a\ns1"], sources })
    expect(panes.map((p) => p.sessionID)).toEqual(["s2", "s1"])
    expect(panes.every((p) => p.pinned)).toBe(true)
    expect(panes.every((p) => p.kind === "live")).toBe(true)
  })

  test("auto candidates fill remaining slots ordered by most recent activity", () => {
    const sources = [
      source("/a", "s1", 100, false, false),
      source("/a", "s2", 200, true, false),
      source("/a", "s3", 300, true, false),
      source("/a", "s4", 400, false, true),
    ]
    const panes = computeBoardPanes({ pinned: ["/a\ns1"], sources })
    expect(panes.map((p) => p.sessionID)).toEqual(["s1", "s4", "s3", "s2"])
    expect(panes.map((p) => p.pinned)).toEqual([true, false, false, false])
  })

  test("idle sessions are never auto-added", () => {
    const sources = [source("/a", "s1", 200, false, false), source("/a", "s2", 100, true, false)]
    const panes = computeBoardPanes({ pinned: [], sources })
    expect(panes.map((p) => p.sessionID)).toEqual(["s2"])
  })

  test("a leftover pinned key whose session vanished becomes an unavailable pane", () => {
    const sources = [source("/a", "s1", 100, true, false)]
    const panes = computeBoardPanes({ pinned: ["/a\ngone", "/a\ns1"], sources })
    expect(panes[0]).toMatchObject({ key: "/a\ngone", sessionID: "gone", kind: "unavailable", pinned: true })
    expect(panes[1]).toMatchObject({ sessionID: "s1", kind: "live", pinned: true })
  })

  test("respects the cap and does not duplicate pinned + auto", () => {
    const sources = [
      source("/a", "s1", 100, true, false),
      source("/a", "s2", 90, true, false),
      source("/a", "s3", 80, true, false),
      source("/a", "s4", 70, true, false),
      source("/a", "s5", 60, true, false),
      source("/a", "s6", 50, true, false),
      source("/a", "s7", 40, true, false),
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
