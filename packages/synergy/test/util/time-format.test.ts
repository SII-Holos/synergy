import { describe, expect, test } from "bun:test"
import { formatLocalDate, formatLocalDateTime } from "@/util/time-format"

const FIXED_TS = Date.UTC(2026, 5, 22, 3, 0, 0) // 2026-06-22 03:00:00 UTC

function expectedOffset(d: Date): string {
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? "+" : "-"
  const absOffset = Math.abs(offset)
  const hours = String(Math.floor(absOffset / 60)).padStart(2, "0")
  const minutes = String(absOffset % 60).padStart(2, "0")
  return `(UTC${sign}${hours}:${minutes})`
}

function expectedDateParts(d: Date) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return { y, m, d: day }
}

function expectedTimeParts(d: Date) {
  const h = String(d.getHours()).padStart(2, "0")
  const mi = String(d.getMinutes()).padStart(2, "0")
  const s = String(d.getSeconds()).padStart(2, "0")
  return { h, mi, s }
}

// ---------------------------------------------------------------------------
// formatLocalDate
// ---------------------------------------------------------------------------
describe("formatLocalDate", () => {
  test("returns date in YYYY-MM-DD (UTC±HH:MM) format", () => {
    const result = formatLocalDate(FIXED_TS)
    const d = new Date(FIXED_TS)
    const { y, m, d: day } = expectedDateParts(d)
    const offset = expectedOffset(d)
    expect(result).toBe(`${y}-${m}-${day} ${offset}`)
  })

  test("date components match local calendar date", () => {
    const result = formatLocalDate(FIXED_TS)
    const d = new Date(FIXED_TS)
    const { y, m, d: day } = expectedDateParts(d)
    expect(result.startsWith(`${y}-${m}-${day}`)).toBe(true)
  })

  test("output ends with UTC offset annotation", () => {
    const result = formatLocalDate(FIXED_TS)
    expect(result).toMatch(/ \(UTC[+-]\d{2}:\d{2}\)$/)
  })
})

// ---------------------------------------------------------------------------
// formatLocalDateTime
// ---------------------------------------------------------------------------
describe("formatLocalDateTime", () => {
  test("returns datetime in YYYY-MM-DD HH:MM:SS (UTC±HH:MM) format", () => {
    const result = formatLocalDateTime(FIXED_TS)
    const d = new Date(FIXED_TS)
    const { y, m, d: day } = expectedDateParts(d)
    const { h, mi, s } = expectedTimeParts(d)
    const offset = expectedOffset(d)
    expect(result).toBe(`${y}-${m}-${day} ${h}:${mi}:${s} ${offset}`)
  })

  test("includes time components in HH:MM:SS format", () => {
    const result = formatLocalDateTime(FIXED_TS)
    expect(result).toMatch(/ \d{2}:\d{2}:\d{2} /)
  })

  test("time components match local clock time", () => {
    const result = formatLocalDateTime(FIXED_TS)
    const d = new Date(FIXED_TS)
    const { h, mi, s } = expectedTimeParts(d)
    expect(result).toContain(` ${h}:${mi}:${s} `)
  })

  test("output ends with UTC offset annotation", () => {
    const result = formatLocalDateTime(FIXED_TS)
    expect(result).toMatch(/ \(UTC[+-]\d{2}:\d{2}\)$/)
  })
})

// ---------------------------------------------------------------------------
// Offset consistency
// ---------------------------------------------------------------------------
describe("formatOffset consistency", () => {
  test("both functions produce the same UTC offset for a given timestamp", () => {
    const dateResult = formatLocalDate(FIXED_TS)
    const dateTimeResult = formatLocalDateTime(FIXED_TS)
    const d = new Date(FIXED_TS)
    const offset = expectedOffset(d)
    expect(dateResult).toContain(offset)
    expect(dateTimeResult).toContain(offset)
  })

  test("UTC offset reflects getTimezoneOffset sign inversion", () => {
    const d = new Date(FIXED_TS)
    const offsetMinutes = -d.getTimezoneOffset()
    const sign = offsetMinutes >= 0 ? "+" : "-"
    const result = formatLocalDate(FIXED_TS)
    expect(result).toContain(`(UTC${sign}`)
  })
})
