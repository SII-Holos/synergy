import { describe, expect, test } from "bun:test"
import type { SessionStatus } from "@ericsanchezok/synergy-sdk"
import { classifySessionActivity, isPausedStatus, isWorkingStatus } from "../../src/utils/session-status"

const idle: SessionStatus = { type: "idle" }
const busy: SessionStatus = { type: "busy" }
const retry: SessionStatus = { type: "retry", attempt: 1, message: "rate limited", next: 100 }
const paused: SessionStatus = { type: "paused", reason: "interrupted", since: 1 }

describe("isWorkingStatus", () => {
  test("counts only busy and retry as working", () => {
    expect(isWorkingStatus(busy)).toBe(true)
    expect(isWorkingStatus(retry)).toBe(true)
    // A paused session is stopped, not working. Counting it as work is exactly
    // the spinner that no event can clear.
    expect(isWorkingStatus(paused)).toBe(false)
  })

  test("treats idle and a missing status as not working", () => {
    expect(isWorkingStatus(idle)).toBe(false)
    // A missing status is "unknown", not "running" — a session with no status
    // evidence must not render a spinner that no event can clear.
    expect(isWorkingStatus(undefined)).toBe(false)
  })
})

describe("isPausedStatus", () => {
  test("only matches paused", () => {
    expect(isPausedStatus(paused)).toBe(true)
    expect(isPausedStatus(busy)).toBe(false)
    expect(isPausedStatus(idle)).toBe(false)
    expect(isPausedStatus(undefined)).toBe(false)
  })
})

describe("classifySessionActivity", () => {
  test("waiting outranks every runtime status", () => {
    for (const status of [idle, busy, retry, paused, undefined]) {
      expect(classifySessionActivity({ status, waiting: true })).toBe("waiting")
    }
  })

  test("paused stays distinct from ordinary working", () => {
    expect(classifySessionActivity({ status: paused })).toBe("paused")
    expect(classifySessionActivity({ status: busy })).toBe("working")
    expect(classifySessionActivity({ status: retry })).toBe("working")
  })

  test("idle and a missing status classify as idle", () => {
    expect(classifySessionActivity({ status: idle })).toBe("idle")
    expect(classifySessionActivity({ status: undefined })).toBe("idle")
    expect(classifySessionActivity({})).toBe("idle")
  })

  test("paused outranks working but not waiting", () => {
    expect(classifySessionActivity({ status: paused, waiting: false })).toBe("paused")
    expect(classifySessionActivity({ status: paused, waiting: true })).toBe("waiting")
  })
})
