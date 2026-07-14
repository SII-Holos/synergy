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
    const resetAt = new Date(now + 90 * 60 * 1000).toISOString()
    const sentence = formatUsageResetSentence(resetAt, now)
    const compact = formatUsageResetCompact(resetAt, now)

    expect(sentence?.value).toMatch(/^Resets today at /)
    expect(sentence?.title).toBe(sentence?.value)
    expect(compact?.value).toMatch(/^Today at /)
    expect(compact?.title).toBe(sentence?.value)
    expect(formatUsageResetSentence(undefined, now)).toBeUndefined()
    expect(formatUsageResetSentence("not-a-date", now)).toBeUndefined()
  })

  test("finds the next future reset across connected snapshots", () => {
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
      now,
    )

    expect(reset?.value).toMatch(/^Today at /)
    expect(reset?.title).toMatch(/^Resets today at /)
  })
})
