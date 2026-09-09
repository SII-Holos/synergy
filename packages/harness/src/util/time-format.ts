/**
 * Local time formatting utilities.
 *
 * All output uses the local system timezone with an explicit UTC offset
 * annotation, so both humans and agents can interpret timestamps correctly
 * without guessing the timezone.
 */

/**
 * Format a timestamp as a local date string.
 *
 * @example "2026-06-22 (UTC+08:00)"
 */
export function formatLocalDate(timestamp: number): string {
  const date = new Date(timestamp)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d} ${formatOffset(date)}`
}

/**
 * Format a timestamp as a local date + time string.
 *
 * @example "2026-06-22 11:30:00 (UTC+08:00)"
 */
export function formatLocalDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  const y = date.getFullYear()
  const mo = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  const h = String(date.getHours()).padStart(2, "0")
  const mi = String(date.getMinutes()).padStart(2, "0")
  const s = String(date.getSeconds()).padStart(2, "0")
  return `${y}-${mo}-${d} ${h}:${mi}:${s} ${formatOffset(date)}`
}

/**
 * Format the UTC offset from a Date object.
 *
 * @example "(UTC+08:00)"
 */
function formatOffset(date: Date): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? "+" : "-"
  const absOffset = Math.abs(offset)
  const hours = String(Math.floor(absOffset / 60)).padStart(2, "0")
  const minutes = String(absOffset % 60).padStart(2, "0")
  return `(UTC${sign}${hours}:${minutes})`
}
