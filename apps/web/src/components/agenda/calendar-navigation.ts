import { addDays, addMonths, startOfWeek } from "./date"

export function calendarKeyDate(date: number, key: string, shift = false): number | undefined {
  if (key === "ArrowLeft") return addDays(date, -1)
  if (key === "ArrowRight") return addDays(date, 1)
  if (key === "ArrowUp") return addDays(date, -7)
  if (key === "ArrowDown") return addDays(date, 7)
  if (key === "Home") return startOfWeek(date)
  if (key === "End") return addDays(startOfWeek(date), 6)
  if (key === "PageUp") return addMonths(date, shift ? -12 : -1)
  if (key === "PageDown") return addMonths(date, shift ? 12 : 1)
}
