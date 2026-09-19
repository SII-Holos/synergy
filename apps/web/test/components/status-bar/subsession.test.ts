import { describe, expect, test } from "bun:test"
import type { I18n } from "@lingui/core"
import type { SessionStatus } from "@ericsanchezok/synergy-sdk"
import {
  normalizeSubsessionSearch,
  resolveSubsessionStatus,
  subsessionCursorParams,
  subsessionRangeLabel,
} from "../../../src/components/status-bar/subsession"
import { isWorkingStatus } from "../../../src/utils/session-status"

function mockI18n(): I18n {
  return {
    _: (descriptor: { id: string; message: string; values?: Record<string, unknown> }) => {
      let msg = descriptor.message
      if (descriptor.values) {
        for (const [key, value] of Object.entries(descriptor.values)) {
          msg = msg.replace(`{${key}}`, String(value))
        }
      }
      return msg
    },
  } as unknown as I18n
}

describe("status bar subsession helpers", () => {
  test("formats paginated ranges", () => {
    const i18n = mockI18n()
    expect(subsessionRangeLabel(0, 8, 8, 23, i18n)).toBe("1–8 of 23")
    expect(subsessionRangeLabel(1, 8, 8, 23, i18n)).toBe("9–16 of 23")
    expect(subsessionRangeLabel(2, 8, 7, 23, i18n)).toBe("17–23 of 23")
    expect(subsessionRangeLabel(0, 8, 0, 0, i18n)).toBe("0 of 0")
  })

  test("serializes cursor query params only when a cursor exists", () => {
    expect(subsessionCursorParams(null)).toEqual({})
    expect(subsessionCursorParams({ lastActivityAt: 42, id: "ses_2" })).toEqual({
      cursorLastActivityAt: 42,
      cursorId: "ses_2",
    })
  })

  test("normalizes search before sending a query", () => {
    expect(normalizeSubsessionSearch("  build  ")).toBe("build")
  })

  test("uses waiting before running and falls back to idle", () => {
    expect(resolveSubsessionStatus({ waiting: true, running: true })).toBe("waiting")
    expect(resolveSubsessionStatus({ waiting: false, running: true })).toBe("running")
    expect(resolveSubsessionStatus({ waiting: false, running: false })).toBe("idle")
  })
})

// status-bar.tsx decides a child session's running state as
// `isWorkingStatus(status)` fed into the resolver. That closure is not
// exported, so the composition is asserted here: every status the shell
// classifies as working must surface as a running subsession, and a missing
// status must stay idle rather than render a running row.
describe("subsession running classification", () => {
  const childState = (status: SessionStatus | undefined, waiting = false) =>
    resolveSubsessionStatus({ waiting, running: isWorkingStatus(status) })

  test("surfaces busy, retry, and recovering child sessions as running", () => {
    expect(childState({ type: "busy" })).toBe("running")
    expect(childState({ type: "retry", attempt: 1, message: "rate limited", next: 1_000 })).toBe("running")
    expect(childState({ type: "recovering" })).toBe("running")
  })

  test("keeps a missing or idle child status out of running", () => {
    expect(childState(undefined)).toBe("idle")
    expect(childState({ type: "idle" })).toBe("idle")
  })

  test("reports a waiting child as waiting instead of running", () => {
    expect(childState({ type: "recovering" }, true)).toBe("waiting")
  })
})
