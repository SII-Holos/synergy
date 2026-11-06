import { expect, test } from "bun:test"
import type { AgendaItem } from "@ericsanchezok/synergy-sdk/client"
import { forecastAgenda, agendaRange, filterAgendaTasks } from "../../../src/components/agenda/forecast"
import { addMonths } from "../../../src/components/agenda/date"

const start = new Date(2026, 9, 2).getTime()
const end = new Date(2026, 9, 3).getTime()
const item = (status: AgendaItem["status"]): AgendaItem =>
  ({
    id: status,
    title: status,
    status,
    time: { created: start, updated: start },
    triggers: [{ type: "at", at: start + 3600000 }],
  }) as AgendaItem

test("arrangements contain enabled rules only, rather than paused or archived predictions", () => {
  expect(
    forecastAgenda(
      [item("active"), item("paused"), item("pending"), item("done"), item("cancelled")],
      { start, end },
      { now: start },
    ).events.map((event) => event.itemId),
  ).toEqual(["active"])
})

test("list dates select seven upcoming days while calendar views keep their own range", () => {
  const anchor = new Date(2026, 9, 2, 12).getTime()
  expect(agendaRange(anchor, "list")).toEqual({ start, end: new Date(2026, 9, 9).getTime() })
  expect(agendaRange(anchor, "day")).toEqual({ start, end })
  expect(agendaRange(anchor, "week").start).toBe(new Date(2026, 8, 27).getTime())
})

test("forecasts never invent past executions or times before rule creation", () => {
  const rule = {
    ...item("active"),
    time: { created: start + 3 * 3600000, updated: start },
    triggers: [{ type: "cron", expr: "0 * * * *" }],
  } as AgendaItem
  const result = forecastAgenda([rule], { start, end }, { now: start + 3600000 })
  expect(result.events[0]?.time).toBe(start + 3 * 3600000)
  expect(result.events.every((event) => event.time >= rule.time.created)).toBe(true)
})

test("duplicate triggers share an occurrence identity across ranges, and paused previews remain explicit", () => {
  const rule = {
    ...item("paused"),
    triggers: [
      { type: "at", at: start + 3600000 },
      { type: "at", at: start + 3600000 },
    ],
  } as AgendaItem
  const result = forecastAgenda([rule], { start, end }, { now: start, preview: true })
  expect(result.events).toHaveLength(1)
  expect(forecastAgenda([rule], { start: start + 1800000, end }, { now: start, preview: true }).events[0]?.id).toBe(
    result.events[0]?.id,
  )
  expect(forecastAgenda([rule], { start, end }, { now: start }).events).toEqual([])
})

test("dense and invalid rules disclose incomplete predictions instead of silently claiming complete coverage", () => {
  const rule = {
    ...item("active"),
    triggers: [
      { type: "every", interval: "1s", anchor: start },
      { type: "cron", expr: "* * * * *" },
      { type: "cron", expr: "invalid" },
    ],
  } as AgendaItem
  const result = forecastAgenda([rule], { start, end }, { now: start })
  expect(result.limited).toEqual(["active"])
  expect(result.invalid).toEqual(["active"])
  expect(result.events.length).toBeLessThanOrEqual(700)
})

test("tasks keep manual, disabled and archived rules discoverable within the chosen Scope and query", () => {
  const rules = [item("active"), item("pending"), item("paused"), item("done")].map((rule) => ({
    ...rule,
    origin: { scope: { id: "scope-a", type: "project" } },
    triggers: [],
  })) as AgendaItem[]
  expect(filterAgendaTasks(rules, { scopeID: "scope-a", query: "" })).toHaveLength(4)
  expect(filterAgendaTasks(rules, { scopeID: "scope-a", query: "paused" }).map((rule) => rule.id)).toEqual(["paused"])
  expect(filterAgendaTasks(rules, { scopeID: "scope-b", query: "" })).toEqual([])
  expect(filterAgendaTasks(rules, { scopeID: "", query: "", filter: "archived" }).map((rule) => rule.id)).toEqual([
    "done",
  ])
})

test("month navigation keeps the intended month when the selected day does not exist", () => {
  const date = new Date(addMonths(new Date(2026, 0, 31, 12).getTime(), 1))
  expect([date.getMonth(), date.getDate(), date.getHours()]).toEqual([1, 28, 12])
})

test("millisecond intervals use the same duration units as the Agenda runtime", () => {
  const rule = { ...item("active"), triggers: [{ type: "every", interval: "1000ms", anchor: start }] } as AgendaItem
  const result = forecastAgenda([rule], { start, end: start + 5000 }, { now: start + 1 })
  expect(result.invalid).toEqual([])
  expect(result.events.map((event) => event.time)).toEqual([start + 1000, start + 2000, start + 3000, start + 4000])
})
test("floating interval and delayed rules show the known next time, without inventing later runs", () => {
  for (const trigger of [
    { type: "every", interval: "30m" },
    { type: "delay", delay: "1h" },
  ]) {
    const rule = { ...item("active"), triggers: [trigger], state: { nextRunAt: start + 90 * 60000 } } as AgendaItem
    const result = forecastAgenda([rule], { start, end }, { now: start + 60000 })
    expect(result.events.map((event) => event.time)).toEqual([start + 90 * 60000])
    expect(result.relative).toEqual(["active"])
  }
})
test("relative previews do not reuse stale next times from disabled rules or manufacture a missing next time", () => {
  for (const status of ["active", "paused", "pending"] as const) {
    const rule = {
      ...item(status),
      triggers: [{ type: "delay", delay: "1h" }],
      state: status === "active" ? {} : { nextRunAt: start + 3600000 },
    } as AgendaItem
    const result = forecastAgenda([rule], { start, end }, { now: start, preview: true })
    expect(result.events).toEqual([])
    expect(result.relative).toEqual([status])
  }
})
test("an explicit interval anchor defines the runtime cadence even when the anchor is in the future", () => {
  const rule = {
    ...item("active"),
    triggers: [{ type: "every", interval: "1h", anchor: start + 3 * 3600000 }],
  } as AgendaItem
  expect(forecastAgenda([rule], { start, end }, { now: start + 30 * 60000 }).events[0]?.time).toBe(start + 3600000)
})
