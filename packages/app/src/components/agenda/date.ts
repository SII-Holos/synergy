export const MS_PER_DAY = 86_400_000

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
  return ts + days * MS_PER_DAY
}

export function addMonths(ts: number, months: number): number {
  const d = new Date(ts)
  d.setMonth(d.getMonth() + months)
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

export function formatHour(h: number): string {
  return `${h.toString().padStart(2, "0")}:00`
}

export const MONTH_NAMES_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
export const DAY_LABELS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
export const DAY_LABELS_MINI = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]
