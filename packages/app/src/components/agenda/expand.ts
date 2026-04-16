import { Cron } from "croner"
import type { AgendaItem, AgendaTrigger } from "@ericsanchezok/synergy-sdk/client"

export interface CalendarEvent {
  id: string
  itemId: string
  title: string
  status: string
  time: number
  triggerType: string
}

const TIME_TRIGGERS = new Set(["at", "cron", "every", "delay"])

export function isTimeTrigger(t: AgendaTrigger): boolean {
  return TIME_TRIGGERS.has(t.type)
}

export function hasTimeTriggers(item: AgendaItem): boolean {
  return !!item.triggers?.some(isTimeTrigger)
}

function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(s|m|h|d|w)$/)
  if (!match) return 0
  const value = parseInt(match[1], 10)
  const multipliers: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
  return value * (multipliers[match[2]] ?? 0)
}

export function expandItem(item: AgendaItem, rangeStart: number, rangeEnd: number): CalendarEvent[] {
  const events: CalendarEvent[] = []
  const triggers = item.triggers ?? []
  let seq = 0

  for (const trigger of triggers) {
    switch (trigger.type) {
      case "at": {
        if (trigger.at >= rangeStart && trigger.at < rangeEnd) {
          events.push(makeEvent(item, trigger.type, trigger.at, seq++))
        }
        break
      }

      case "delay": {
        const target = item.time.created + parseDuration(trigger.delay)
        if (target >= rangeStart && target < rangeEnd) {
          events.push(makeEvent(item, trigger.type, target, seq++))
        }
        break
      }

      case "every": {
        const interval = parseDuration(trigger.interval)
        if (interval <= 0) break
        const anchor = trigger.anchor ?? item.time.created
        const elapsed = rangeStart - anchor
        const startTick = Math.max(0, Math.ceil(elapsed / interval))
        for (let tick = startTick; tick < startTick + 500; tick++) {
          const time = anchor + tick * interval
          if (time >= rangeEnd) break
          if (time >= rangeStart) events.push(makeEvent(item, trigger.type, time, seq++))
        }
        break
      }

      case "cron": {
        try {
          const cron = new Cron(trigger.expr, { timezone: trigger.tz })
          const runs = cron.nextRuns(200, new Date(rangeStart))
          for (const run of runs) {
            const t = run.getTime()
            if (t >= rangeEnd) break
            if (t >= rangeStart) events.push(makeEvent(item, trigger.type, t, seq++))
          }
        } catch {
          // invalid cron expression, skip
        }
        break
      }
    }
  }

  return events
}

export function expandItems(items: AgendaItem[], rangeStart: number, rangeEnd: number): CalendarEvent[] {
  return items.flatMap((item) => expandItem(item, rangeStart, rangeEnd)).sort((a, b) => a.time - b.time)
}

function makeEvent(item: AgendaItem, triggerType: string, time: number, seq: number): CalendarEvent {
  return {
    id: `${item.id}-${seq}`,
    itemId: item.id,
    title: item.title,
    status: item.status,
    time,
    triggerType,
  }
}
