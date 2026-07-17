import { createIntlFormatter } from "@/context/locale/formatter"

import { setupI18n } from "@lingui/core"
import { describe, expect, test } from "bun:test"
import {
  formatUsageResetCompact,
  formatUsageResetSentence,
  formatUsageWindowDetail,
  formatUsageWindowLabel,
  formatUsageWindowValue,
  nextUsageReset,
  usageWindowMeterPercent,
} from "./UsagePanel.model"

describe("Usage panel model", () => {
  const now = Date.UTC(2026, 6, 3, 12, 0, 0)

  test("does not infer a fixed duration from provider session labels", () => {
    expect(formatUsageWindowLabel("Session")).toBe("Session window")
    expect(formatUsageWindowLabel("Current session")).toBe("Session window")
  })

  test("uses human-facing quota window labels and values", () => {
    expect(formatUsageWindowLabel("Weekly")).toBe("Weekly window")
    expect(formatUsageWindowLabel("Current week")).toBe("Weekly window")
    expect(formatUsageWindowValue({ label: "Session", remainingPercent: 94 })).toBe("94% remaining")
    expect(formatUsageWindowValue({ label: "Session", usedPercent: 54 })).toBe("54% used")
    expect(usageWindowMeterPercent({ label: "Session", remainingPercent: 94.4 })).toBe(94)
  })

  test("keeps provider details separate from reset timing", () => {
    const resetAt = new Date(now + 90 * 60 * 1000).toISOString()
    expect(
      formatUsageWindowDetail({
        label: "API key quota",
        remainingPercent: 24,
        resetAt,
        detail: "$12.00 of $50.00 remaining",
      }),
    ).toBe("$12.00 of $50.00 remaining")
  })

  test("formats reset timing as product copy", () => {
    const fmt = createIntlFormatter(() => "en")
    const resetAt = new Date(now + 90 * 60 * 1000).toISOString()
    const sentence = formatUsageResetSentence(resetAt, fmt, now)
    const compact = formatUsageResetCompact(resetAt, fmt, now)
    expect(sentence?.value).toMatch(/^Resets today at /)
    expect(sentence?.title).toBe(sentence?.value)
    expect(sentence?.descriptor).toEqual(compact?.descriptor)
    expect(compact?.value).toMatch(/^Today at /)
    expect(compact?.title).toBe(sentence?.value)
    const time = compact?.title.replace("Resets today at ", "")
    expect(compact?.descriptor.message).toBe(
      "Resets {day, select, today {today} tomorrow {tomorrow} other {{date}}} at {time}",
    )
    expect(compact?.descriptor.values).toEqual({ day: "today", date: "today", time })
    expect(compact?.valueDescriptor.message).toBe(
      "{day, select, today {Today} tomorrow {Tomorrow} other {{date}}} at {time}",
    )
    expect(compact?.valueDescriptor.values).toEqual({ day: "today", date: "Today", time })
    const i18n = setupI18n({ locale: "en" })
    expect(compact && i18n._(compact.descriptor)).toBe(compact?.title)
    expect(compact && i18n._(compact.valueDescriptor)).toBe(compact?.value)
    expect(formatUsageResetSentence(undefined, fmt, now)).toBeUndefined()
    expect(formatUsageResetSentence("not-a-date", fmt, now)).toBeUndefined()
  })

  test("finds the next future reset across connected snapshots", () => {
    const fmt = createIntlFormatter(() => "en")
    const earliest = new Date(now + 2 * 60 * 60 * 1000).toISOString()
    const later = new Date(now + 8 * 60 * 60 * 1000).toISOString()
    const past = new Date(now - 60 * 1000).toISOString()

    const reset = nextUsageReset(
      [
        {
          providerID: "openai-codex",
          status: "available",
          fetchedAt: new Date(now).toISOString(),
          windows: [
            { label: "Session", remainingPercent: 94, resetAt: later },
            { label: "Weekly", remainingPercent: 46, resetAt: earliest },
          ],
          details: [],
        },
        {
          providerID: "anthropic",
          status: "available",
          fetchedAt: new Date(now).toISOString(),
          windows: [{ label: "Current session", remainingPercent: 80, resetAt: past }],
          details: [],
        },
      ],
      fmt,
      now,
    )

    expect(reset?.value).toMatch(/^Today at /)
    expect(reset?.title).toMatch(/^Resets today at /)
  })
})
