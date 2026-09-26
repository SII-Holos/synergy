import { expect, test } from "bun:test"
import { agendaSeries } from "../../../src/components/agenda/series"
import type { AgendaItem } from "@ericsanchezok/synergy-sdk/client"
const items = [
  { id: "frequent", status: "active", state: { lastRunStatus: "error" } },
  { id: "todo", status: "pending" },
  { id: "paused", status: "paused", state: { lastRunStatus: "ok" } },
] as AgendaItem[]
const events = [1, 2, 2, 3].map((time, index) => ({
  id: String(index),
  itemId: "frequent",
  title: "same series",
  time,
  status: "active",
  triggerType: "every",
}))
test("dense scheduled occurrences form one series and duplicate trigger times are shown once", () => {
  const rows = agendaSeries(items, events, "all")
  expect(rows).toHaveLength(3)
  expect(rows[0]?.times).toEqual([1, 2, 3])
  expect(rows[1]?.times).toEqual([])
})
test("failure and pending filters preserve canonical item status without requiring run metadata", () => {
  expect(agendaSeries(items, events, "failed").map((row) => row.item.id)).toEqual(["frequent"])
  expect(agendaSeries(items, events, "pending").map((row) => row.item.id)).toEqual(["todo"])
  expect(items[2]?.status).toBe("paused")
})
