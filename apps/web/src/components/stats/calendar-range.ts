export function calendarDate(day: string): Date {
  const [year, month, date] = day.split("-").map(Number)
  return new Date(year, month - 1, date)
}

export function calendarDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

export function calendarDays<T extends { day: string }>(
  days: readonly T[],
  count: number | "all",
  through: Date,
  empty: (day: string) => T,
): T[] {
  const end = calendarDay(through)
  const available = days.filter((item) => item.day <= end)
  if (count === "all" && available.length === 0) return []
  const start = count === "all" ? available.reduce((first, item) => (item.day < first ? item.day : first), end) : end
  const cursor = calendarDate(start)
  if (count !== "all") cursor.setDate(cursor.getDate() - count + 1)
  const indexed = new Map(available.map((item) => [item.day, item]))
  const result: T[] = []
  for (let key = calendarDay(cursor); key <= end; cursor.setDate(cursor.getDate() + 1), key = calendarDay(cursor)) {
    result.push(indexed.get(key) ?? empty(key))
  }
  return result
}
