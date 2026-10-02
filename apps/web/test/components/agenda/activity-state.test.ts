import { expect, test } from "bun:test"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import {
  defaultAgendaActivityState,
  requestAgendaActivity,
  groupAgendaActivity,
} from "../../../src/components/agenda/activity-state"
import type { AgendaActivityEntry } from "@ericsanchezok/synergy-sdk/client"

test("a failed history request cannot become a successful empty history", async () => {
  const client = createSynergyClient({
    baseUrl: "http://agenda.test",
    fetch: Object.assign(async () => Response.json({ data: { message: "history unavailable" } }, { status: 503 }), {
      preconnect() {},
    }),
  })
  await expect(
    requestAgendaActivity({ client, scopeID: "scope-fixture", state: defaultAgendaActivityState() }),
  ).rejects.toMatchObject({ data: { message: "history unavailable" } })
})

test("history pagination carries the selected Scope and query through the generated client", async () => {
  let requested: URL | undefined
  const page = { items: [], offset: 2, limit: 25, total: 2, hasMore: false }
  const client = createSynergyClient({
    baseUrl: "http://agenda.test",
    fetch: Object.assign(
      async (request: RequestInfo | URL) => {
        requested = new URL(new Request(request).url)
        return Response.json(page)
      },
      { preconnect() {} },
    ),
  })
  const state = { ...defaultAgendaActivityState(), offset: 2 }
  expect(
    await requestAgendaActivity({ client, scopeID: "scope-fixture", query: "matching", append: true, state }),
  ).toEqual(page)
  expect(requested?.searchParams.get("scopeID")).toBe("scope-fixture")
  expect(requested?.searchParams.get("query")).toBe("matching")
  expect(requested?.searchParams.get("offset")).toBe("2")
})

test("history sorts actual runs by day independently of their rule lifecycle", () => {
  const entry = (id: string, time: number, status: string) =>
    ({ agenda: { id, title: id, status }, run: { id, status: "ok", time: { started: time } } }) as AgendaActivityEntry
  const early = new Date(2026, 9, 1, 12).getTime()
  const late = new Date(2026, 9, 2, 8).getTime()
  const records = [
    entry("paused", early, "paused"),
    entry("done", late, "done"),
    entry("active", late + 3600000, "active"),
  ]
  expect(groupAgendaActivity(records).map((group) => group.entries.map((record) => record.agenda.id))).toEqual([
    ["active", "done"],
    ["paused"],
  ])
  expect(records.map((record) => record.agenda.id)).toEqual(["paused", "done", "active"])
})
