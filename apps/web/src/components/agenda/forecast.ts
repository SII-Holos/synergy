import { Cron } from "croner"
import type { AgendaItem } from "@ericsanchezok/synergy-sdk/client"
import { addDays, monthRange, startOfDay, startOfWeek } from "./date"

export type AgendaViewMode = "list" | "day" | "week" | "month"

export interface CalendarEvent {
  id: string
  itemId: string
  title: string
  time: number
  triggerType: string
}

export function agendaRange(anchor: number, view: AgendaViewMode) {
  if (view === "month") return monthRange(anchor)
  const start = view === "week" ? startOfWeek(anchor) : startOfDay(anchor)
  return { start, end: addDays(start, view === "day" ? 1 : 7) }
}

function duration(value: string) {
  const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(value)
  if (!match) return 0
  const units: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
  return Number(match[1]) * units[match[2]]
}

export function forecastAgenda(
  items: AgendaItem[],
  range: { start: number; end: number },
  options: { now: number; preview?: boolean },
) {
  const events = new Map<string, CalendarEvent>()
  const limited = new Set<string>()
  const invalid = new Set<string>()
  const relative = new Set<string>()
  for (const item of items) {
    if (!options.preview && item.status !== "active") continue
    const start = Math.max(range.start, options.now + 1, item.time.created)
    if (start >= range.end) continue
    const add = (time: number, triggerType: string) => {
      if (time < start || time >= range.end) return
      const id = `${item.id}:${time}`
      events.set(id, { id, itemId: item.id, title: item.title, time, triggerType })
    }
    const addKnownNext = () => {
      relative.add(item.id)
      if (item.status === "active" && item.state?.nextRunAt !== undefined) add(item.state.nextRunAt, "next")
    }
    for (const trigger of item.triggers ?? []) {
      if (trigger.type === "at") add(trigger.at, trigger.type)
      if (trigger.type === "delay") {
        const delay = duration(trigger.delay)
        if (delay > 0 && Number.isFinite(delay)) addKnownNext()
        else invalid.add(item.id)
      }
      if (trigger.type === "every") {
        const interval = duration(trigger.interval)
        if (interval <= 0 || !Number.isFinite(interval)) {
          invalid.add(item.id)
          continue
        }
        if (trigger.anchor === undefined) {
          addKnownNext()
          continue
        }
        const anchor = trigger.anchor
        const first = Math.ceil((start - anchor) / interval)
        for (let tick = first; tick < first + 500; tick++) {
          const time = anchor + tick * interval
          if (time >= range.end) break
          add(time, trigger.type)
        }
        if (anchor + (first + 500) * interval < range.end) limited.add(item.id)
      }
      if (trigger.type === "cron") {
        try {
          const cron = new Cron(trigger.expr, { timezone: trigger.tz })
          const runs = cron.nextRuns(201, new Date(start - 1))
          for (const run of runs.slice(0, 200)) add(run.getTime(), trigger.type)
          if (runs[200] && runs[200].getTime() < range.end) limited.add(item.id)
        } catch {
          invalid.add(item.id)
        }
      }
    }
  }
  return {
    events: [...events.values()].sort((a, b) => a.time - b.time || a.itemId.localeCompare(b.itemId)),
    limited: [...limited],
    invalid: [...invalid],
    relative: [...relative],
  }
}

export type AgendaTaskFilter = "all" | "active" | "pending" | "paused" | "archived" | "failed"

export function filterAgendaTasks(
  items: AgendaItem[],
  input: { query: string; scopeID: string; filter?: AgendaTaskFilter },
) {
  const query = input.query.trim().toLocaleLowerCase()
  return items.filter((item) => {
    if (input.scopeID && item.origin.scope.id !== input.scopeID) return false
    if (
      query &&
      ![item.title, item.description, item.prompt, ...(item.tags ?? [])].some((text) =>
        text?.toLocaleLowerCase().includes(query),
      )
    )
      return false
    if (input.filter === "failed") return item.state?.lastRunStatus === "error"
    if (input.filter === "archived") return item.status === "done" || item.status === "cancelled"
    return !input.filter || input.filter === "all" || item.status === input.filter
  })
}
