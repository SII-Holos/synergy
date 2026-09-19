import { describe, expect, test } from "bun:test"
import type { NavEntry } from "@/context/layout"
import {
  isActiveLightLoopNavEntry,
  resolveLightLoopActivity,
  resolveLightLoopControlState,
} from "../../../src/components/prompt-input/light-loop-control"

function entry(input: Partial<NavEntry> = {}): NavEntry {
  return {
    id: "ses_test",
    scopeID: "scp_test",
    scopeType: "project",
    title: "Test",
    category: "project",
    lastActivityAt: 1,
    pinned: 0,
    archived: false,
    completionNotice: { unread: false, unreadCount: 0 },
    ...input,
  }
}

describe("Light Loop submit control", () => {
  test("reports an active loop as active from the nav entry", () => {
    expect(isActiveLightLoopNavEntry(entry({ workflow: { kind: "lightloop", active: true } }))).toBe(true)
  })

  test("reports a terminal loop as inactive from the backend's nav entry flag", () => {
    expect(isActiveLightLoopNavEntry(entry({ workflow: { kind: "lightloop", active: false } }))).toBe(false)
  })

  test("treats other kinds, missing identity, and missing entries as inactive", () => {
    expect(isActiveLightLoopNavEntry(entry({ workflow: { kind: "plan", active: true } }))).toBe(false)
    expect(isActiveLightLoopNavEntry(entry())).toBe(false)
    expect(isActiveLightLoopNavEntry(undefined)).toBe(false)
  })

  describe("Light Loop activity", () => {
    const liveEntry = entry({ workflow: { kind: "lightloop", active: true } })
    const terminatedEntry = entry({ workflow: { kind: "lightloop", active: false } })

    test("reports a live loop as active from the backend's navigation flag", () => {
      expect(resolveLightLoopActivity({ workflow: { kind: "lightloop" }, entry: liveEntry })).toBe(true)
    })

    test("reports a terminal loop as inactive once the backend clears the record", () => {
      expect(resolveLightLoopActivity({ workflow: undefined, entry: liveEntry })).toBe(false)
    })

    test("trusts the backend's terminal flag while the record still exists", () => {
      expect(resolveLightLoopActivity({ workflow: { kind: "lightloop" }, entry: terminatedEntry })).toBe(false)
    })

    test("falls back to record presence while no navigation list carries the session", () => {
      expect(resolveLightLoopActivity({ workflow: { kind: "lightloop" }, entry: undefined })).toBe(true)
    })

    test("treats other workflow kinds and empty sessions as inactive", () => {
      expect(resolveLightLoopActivity({ workflow: { kind: "plan" }, entry: liveEntry })).toBe(false)
      expect(resolveLightLoopActivity({ workflow: undefined, entry: undefined })).toBe(false)
    })
  })

  test("allows task editing while the session is idle", () => {
    expect(resolveLightLoopControlState({ active: true, working: false, reviewPending: false })).toEqual({
      mode: "editable",
      reason: "editable",
    })
  })

  test("keeps the task read-only while the session is running", () => {
    expect(resolveLightLoopControlState({ active: true, working: true, reviewPending: false })).toEqual({
      mode: "readOnly",
      reason: "working",
    })
  })

  test("keeps the task read-only while completion review is pending", () => {
    expect(resolveLightLoopControlState({ active: true, working: false, reviewPending: true })).toEqual({
      mode: "readOnly",
      reason: "reviewPending",
    })
  })

  test("keeps stale task details read-only after Light Loop exits", () => {
    expect(resolveLightLoopControlState({ active: false, working: false, reviewPending: false })).toEqual({
      mode: "readOnly",
      reason: "inactive",
    })
  })
})
