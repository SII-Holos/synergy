import { describe, expect, test } from "bun:test"
import type { I18n } from "@lingui/core"
import {
  normalizeSubsessionSearch,
  resolveSubsessionStatus,
  subsessionCursorParams,
  subsessionRangeLabel,
} from "../../../src/components/status-bar/subsession"

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
