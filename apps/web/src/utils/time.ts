import type { IntlFormatter } from "@/context/locale"

export function absoluteDate(fmt: IntlFormatter, timestamp: number, includeYear = true): string {
  const d = new Date(timestamp)
  const now = new Date()
  if (includeYear && d.getFullYear() !== now.getFullYear()) {
    return fmt.dateTime(d, { dateStyle: "medium", timeStyle: "short" })
  }
  return fmt.date(d, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

export function relativeTime(fmt: IntlFormatter, timestamp: number): string {
  return fmt.relative(timestamp)
}
