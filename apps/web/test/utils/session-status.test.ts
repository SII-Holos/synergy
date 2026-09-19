import { describe, expect, test } from "bun:test"
import type { SessionStatus } from "@ericsanchezok/synergy-sdk"
import { classifySessionActivity, isRecoveringStatus, isWorkingStatus } from "../../src/utils/session-status"

const idle: SessionStatus = { type: "idle" }
const busy: SessionStatus = { type: "busy" }
const retry: SessionStatus = { type: "retry", attempt: 1, message: "rate limited", next: 100 }
const recovering: SessionStatus = { type: "recovering" }

describe("isWorkingStatus", () => {
  test("counts busy, retry, and recovering as working", () => {
    expect(isWorkingStatus(busy)).toBe(true)
    expect(isWorkingStatus(retry)).toBe(true)
    // Recovering must count as working even though it has its own activity:
    // Kanban header tint and ActiveZone rank it with work in progress.
    expect(isWorkingStatus(recovering)).toBe(true)
  })

  test("treats idle and a missing status as not working", () => {
    expect(isWorkingStatus(idle)).toBe(false)
    // A missing status is "unknown", not "running" — a session with no status
    // evidence must not render a spinner that no event can clear.
    expect(isWorkingStatus(undefined)).toBe(false)
  })
})

describe("isRecoveringStatus", () => {
  test("only matches recovering", () => {
    expect(isRecoveringStatus(recovering)).toBe(true)
    expect(isRecoveringStatus(busy)).toBe(false)
    expect(isRecoveringStatus(idle)).toBe(false)
    expect(isRecoveringStatus(undefined)).toBe(false)
  })
})

describe("classifySessionActivity", () => {
  test("waiting outranks every runtime status", () => {
    for (const status of [idle, busy, retry, recovering, undefined]) {
      expect(classifySessionActivity({ status, waiting: true })).toBe("waiting")
    }
  })

  test("recovering stays distinct from ordinary working", () => {
    expect(classifySessionActivity({ status: recovering })).toBe("recovering")
    expect(classifySessionActivity({ status: busy })).toBe("working")
    expect(classifySessionActivity({ status: retry })).toBe("working")
  })

  test("idle and a missing status classify as idle", () => {
    expect(classifySessionActivity({ status: idle })).toBe("idle")
    expect(classifySessionActivity({ status: undefined })).toBe("idle")
    expect(classifySessionActivity({})).toBe("idle")
  })

  test("recovering outranks working but not waiting", () => {
    expect(classifySessionActivity({ status: recovering, waiting: false })).toBe("recovering")
    expect(classifySessionActivity({ status: recovering, waiting: true })).toBe("waiting")
  })
})
