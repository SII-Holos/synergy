import { expect, test } from "bun:test"
import { calendarDays, calendarDate } from "../../../src/components/stats/calendar-range"

test("a fourteen-day window excludes old activity and fills missing calendar dates", () => {
  const days = calendarDays(
    [
      { day: "2026-09-05", turns: 9 },
      { day: "2026-09-23", turns: 2 },
    ],
    14,
    new Date(2026, 8, 25),
    (day) => ({ day, turns: 0 }),
  )
  expect(days).toHaveLength(14)
  expect(days[0].day).toBe("2026-09-12")
  expect(days.at(-1)).toEqual({ day: "2026-09-25", turns: 0 })
  expect(days.reduce((sum, day) => sum + day.turns, 0)).toBe(2)
})

test("all days starts with the first record and fills gaps through the snapshot date", () => {
  expect(
    calendarDays([{ day: "2024-02-28", turns: 1 }], "all", new Date(2024, 2, 1), (day) => ({ day, turns: 0 })).map(
      (item) => item.day,
    ),
  ).toEqual(["2024-02-28", "2024-02-29", "2024-03-01"])
  expect(calendarDays([], "all", new Date(2026, 8, 25), (day) => ({ day }))).toEqual([])
})

test("fixed windows include zero-activity days and calendar dates stay local", () => {
  const days = calendarDays([], 7, new Date(2026, 0, 3), (day) => ({ day }))
  expect(days.map((item) => item.day)).toEqual([
    "2025-12-28",
    "2025-12-29",
    "2025-12-30",
    "2025-12-31",
    "2026-01-01",
    "2026-01-02",
    "2026-01-03",
  ])
  const date = calendarDate("2026-09-25")
  expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 8, 25])
})
