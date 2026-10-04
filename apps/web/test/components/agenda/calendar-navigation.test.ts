import { expect, test } from "bun:test"
import { calendarKeyDate } from "../../../src/components/agenda/calendar-navigation"

function date(year: number, month: number, day: number, hour = 12) {
  return new Date(year, month - 1, day, hour).getTime()
}

test("calendar arrows navigate civil days and weeks across month boundaries", () => {
  const selected = date(2026, 10, 1)
  expect(calendarKeyDate(selected, "ArrowLeft")).toBe(date(2026, 9, 30))
  expect(calendarKeyDate(selected, "ArrowRight")).toBe(date(2026, 10, 2))
  expect(calendarKeyDate(selected, "ArrowUp")).toBe(date(2026, 9, 24))
  expect(calendarKeyDate(selected, "ArrowDown")).toBe(date(2026, 10, 8))
})

test("Home and End select the edges of the displayed Sunday-first week", () => {
  const selected = date(2026, 10, 1)
  expect(calendarKeyDate(selected, "Home")).toBe(date(2026, 9, 27, 0))
  expect(calendarKeyDate(selected, "End")).toBe(date(2026, 10, 3, 0))
})

test("month and year shortcuts clamp unavailable dates while retaining local time", () => {
  expect(calendarKeyDate(date(2026, 1, 31), "PageDown")).toBe(date(2026, 2, 28))
  expect(calendarKeyDate(date(2026, 3, 31), "PageUp")).toBe(date(2026, 2, 28))
  expect(calendarKeyDate(date(2024, 2, 29), "PageUp", true)).toBe(date(2023, 2, 28))
  expect(calendarKeyDate(date(2024, 2, 29), "PageDown", true)).toBe(date(2025, 2, 28))
})

test("activation and dismissal keys leave calendar date selection to their owners", () => {
  const selected = date(2026, 10, 1)
  for (const key of ["Enter", " ", "Escape", "Tab", "a"]) {
    expect(calendarKeyDate(selected, key)).toBeUndefined()
  }
})
