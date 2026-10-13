import { expect, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { migrateAgendaHomeScope } from "../../src/agenda/scope-migration"

test("Agenda catches up its retained Home data without rewriting absent owners", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const item = { id: "retained", origin: { scope: { id: "global", type: "global" } }, future: { scopeID: "global" } }
    await Storage.write(["agenda", "items", "global", "retained"], item)
    await Storage.write(["agenda", "runs", "global", "retained", "run"], { scopeID: "global", value: 1 })
    await Storage.write(["agenda", "run_index", "global"], { entries: [{ id: "run", itemID: "retained", started: 1 }] })
    await Storage.write(["agenda", "sessions", "retained", "session"], { sessionID: "session", scopeID: "global" })
    await Storage.write(["notes", "global", "absent"], { kind: "blueprint", originScope: "global" })
    await migrateAgendaHomeScope()
    await migrateAgendaHomeScope()
    expect(await Storage.read<unknown>(["agenda", "items", "home", "retained"])).toEqual({
      ...item,
      origin: { scope: { id: "home", type: "home" } },
    })
    expect(await Storage.read<unknown>(["agenda", "sessions", "retained", "session"])).toEqual({
      sessionID: "session",
      scopeID: "home",
    })
    expect(await Storage.read<unknown>(["agenda", "run_index", "home"])).toEqual({
      entries: [{ id: "run", itemID: "retained", started: 1 }],
    })
    expect(await Storage.read<unknown>(["notes", "global", "absent"])).toEqual({
      kind: "blueprint",
      originScope: "global",
    })
    expect(await Storage.list(["agenda", "items", "global"])).toEqual([])
  })
})

test("conflicting Agenda destinations preserve both records", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await Storage.write(["agenda", "items", "global", "retained"], { title: "source" })
    await Storage.write(["agenda", "items", "home", "retained"], { title: "destination" })
    await expect(migrateAgendaHomeScope()).rejects.toThrow("Agenda scope migration conflict")
    expect(await Storage.read<unknown>(["agenda", "items", "global", "retained"])).toEqual({ title: "source" })
    expect(await Storage.read<unknown>(["agenda", "items", "home", "retained"])).toEqual({ title: "destination" })
  })
})
