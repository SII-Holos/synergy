export function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function startOfWeek(ts: number): number {
  const d = new Date(startOfDay(ts))
  d.setDate(d.getDate() - d.getDay())
  return d.getTime()
}

export function addDays(ts: number, days: number): number {
  const date = new Date(ts)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

export function addMonths(ts: number, months: number): number {
  const d = new Date(ts)
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + months)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, last))
  return d.getTime()
}

export function monthRange(ts: number): { start: number; end: number } {
  const d = new Date(ts)
  const first = new Date(d.getFullYear(), d.getMonth(), 1)
  first.setHours(0, 0, 0, 0)
  const start = startOfWeek(first.getTime())
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  last.setHours(0, 0, 0, 0)
  const end = addDays(startOfWeek(last.getTime()), 7)
  return { start, end }
}

import type { IntlFormatter } from "@/context/locale/formatter"

export function getMonthNamesShort(fmt: IntlFormatter): string[] {
  return Array.from({ length: 12 }, (_, i) => fmt.date(new Date(2021, i, 1), { month: "short" }))
}

export function getDayLabelsShort(fmt: IntlFormatter): string[] {
  return Array.from({ length: 7 }, (_, i) => fmt.date(new Date(2021, 0, 3 + i), { weekday: "short" }))
}

export function getDayLabelsMini(fmt: IntlFormatter): string[] {
  return Array.from({ length: 7 }, (_, i) => fmt.date(new Date(2021, 0, 3 + i), { weekday: "narrow" }))
}

export function formatLocaleDate(ts: number, fmt: IntlFormatter): string {
  return fmt.date(new Date(ts), { month: "short", day: "numeric", year: "numeric" })
}
