import type { IntlFormatter } from "@/context/locale/formatter"
import type { AccountUsageSnapshot, AccountUsageWindow } from "@ericsanchezok/synergy-sdk/client"
import type { MessageDescriptor } from "@lingui/core"

export type UsageResetCopy = {
  value: string
  descriptor: MessageDescriptor
  title: string
}

function validTimestamp(value: number) {
  return Number.isFinite(value) && value > 0
}

function sameCalendarDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

type LocaleLike = IntlFormatter
function resetDayLabel(date: Date, now: Date, fmt: LocaleLike) {
  if (sameCalendarDay(date, now)) return "today"
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  if (sameCalendarDay(date, tomorrow)) return "tomorrow"
  return fmt.date(date, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  })
}
function resetTimeLabel(date: Date, fmt: LocaleLike) {
  return fmt.date(date, { hour: "numeric", minute: "2-digit" })
}

function sentenceCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function parseUsageResetAt(value: string | undefined) {
  if (!value) return undefined
  const timestamp = new Date(value).getTime()
  return validTimestamp(timestamp) ? timestamp : undefined
}

export function formatUsageResetCompact(
  resetAt: string | undefined,
  fmt: LocaleLike,
  now = Date.now(),
): UsageResetCopy | undefined {
  const timestamp = parseUsageResetAt(resetAt)
  if (!timestamp) return undefined

  const resetDate = new Date(timestamp)
  const nowDate = new Date(now)
  const day = resetDayLabel(resetDate, nowDate, fmt)
  const time = resetTimeLabel(resetDate, fmt)
  const value = `${sentenceCase(day)} at ${time}`
  const title = `Resets ${day} at ${time}`
  return {
    value,
    descriptor: { id: "settings.usage.resetAt", message: title },
    title,
  }
}

export function formatUsageResetSentence(resetAt: string | undefined, fmt: LocaleLike, now = Date.now()) {
  const reset = formatUsageResetCompact(resetAt, fmt, now)
  return reset ? { value: reset.title, title: reset.title } : undefined
}

export function nextUsageReset(
  snapshots: Array<AccountUsageSnapshot | undefined>,
  fmt: LocaleLike,
  now = Date.now(),
): UsageResetCopy | undefined {
  const next = snapshots
    .flatMap((snapshot) => snapshot?.windows ?? [])
    .map((window) => parseUsageResetAt(window.resetAt))
    .filter((timestamp): timestamp is number => timestamp !== undefined && timestamp >= now)
    .sort((left, right) => left - right)[0]
  return next ? formatUsageResetCompact(new Date(next).toISOString(), fmt, now) : undefined
}

export function formatPercent(value: number | undefined) {
  if (value === undefined) return "n/a"
  return `${Math.round(value)}%`
}

export function formatUsageWindowLabel(label: string) {
  const normalized = label.trim().toLowerCase()
  if (normalized === "session") return "Session window"
  if (normalized === "current session") return "Session window"
  if (normalized === "weekly") return "Weekly window"
  if (normalized === "current week") return "Weekly window"
  if (normalized === "monthly") return "Monthly window"
  return label
}

export function formatUsageWindowValue(window: AccountUsageWindow) {
  if (window.remainingPercent !== undefined) return `${formatPercent(window.remainingPercent)} remaining`
  if (window.usedPercent !== undefined) return `${formatPercent(window.usedPercent)} used`
  return "n/a"
}

export function formatUsageWindowDetail(window: AccountUsageWindow) {
  const detail = window.detail?.trim()
  return detail || undefined
}

export function usageWindowMeterPercent(window: AccountUsageWindow) {
  const value =
    window.remainingPercent !== undefined
      ? window.remainingPercent
      : window.usedPercent !== undefined
        ? 100 - window.usedPercent
        : 0
  return Math.max(0, Math.min(100, Math.round(value)))
}
