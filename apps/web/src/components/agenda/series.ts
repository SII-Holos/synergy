import type { AgendaItem } from "@ericsanchezok/synergy-sdk/client"
import type { CalendarEvent } from "./expand"

export type AgendaSeriesFilter = "all" | "failed" | "pending"

export function agendaSeries(items: AgendaItem[], events: CalendarEvent[], filter: AgendaSeriesFilter) {
  const times = new Map<string, Set<number>>()
  for (const event of events) {
    const series = times.get(event.itemId) ?? new Set<number>()
    series.add(event.time)
    times.set(event.itemId, series)
  }
  return items
    .filter(
      (item) =>
        filter === "all" || (filter === "failed" ? item.state?.lastRunStatus === "error" : item.status === "pending"),
    )
    .map((item) => ({ item, times: [...(times.get(item.id) ?? [])].sort((a, b) => a - b) }))
}
