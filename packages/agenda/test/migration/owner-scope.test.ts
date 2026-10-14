import { expect, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { migrateAgendaHomeScope } from "../../src/agenda/scope-migration"
import { registerAgendaMigrations } from "../../src/agenda/migration"
import { AgendaStore } from "../../src/agenda/store"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { upgradeImportedRecord } from "@ericsanchezok/synergy-harness/migration/import"

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

test("Agenda record access upgrades an already-migrated Home origin without rewriting retained fields", async () => {
  await using runtime = await testRuntime({ register: registerAgendaMigrations })
  await runtime.run(async () => {
    const key = ["agenda", "items", "home", "legacy-home"]
    const legacy = {
      id: "legacy-home",
      status: "active" as const,
      title: "Nightly wake",
      prompt: "Retain this instruction",
      global: true,
      agent: "fixture-agent",
      sessionMode: "ephemeral" as const,
      silent: true,
      wake: false,
      autoDone: false,
      createdBy: "user" as const,
      triggers: [{ type: "cron" as const, expr: "0 3 * * *", tz: "Asia/Shanghai" }],
      origin: {
        scope: {
          type: "home",
          id: "home",
          directory: "/historical/home",
          worktree: "/historical/home",
          future: "scope-extension",
        },
        workspaceID: null,
        future: "origin-extension",
      },
      state: { consecutiveErrors: 2, runCount: 21, nextRunAt: 1, future: "state-extension" },
      time: { created: 10, updated: 20 },
      future: "item-extension",
    }
    await Storage.write(key, legacy)
    await Storage.write(StoragePath.metaMigrationLogDomain("agenda"), { "20261012-agenda-home-scope": 1 })
    const current = {
      ...legacy,
      origin: { ...legacy.origin, scope: { ...Scope.home(), future: "scope-extension" } },
    }
    expect(await AgendaStore.get("home", legacy.id)).toEqual(current)
    expect(await AgendaStore.listStored("home")).toEqual([current])
    expect(await AgendaStore.loadActive()).toEqual([current])
    expect((await AgendaStore.find(legacy.id)).item).toEqual(current)
    expect((await AgendaStore.findInScope("another-scope", legacy.id)).item).toEqual(current)
    expect(await Storage.read<unknown>(key)).toEqual(legacy)
    const imported = upgradeImportedRecord(key, legacy)
    expect(imported).toEqual(current)
    expect(upgradeImportedRecord(key, imported)).toEqual(current)
    expect(upgradeImportedRecord(["notes", "home", "unrelated"], legacy)).toEqual(legacy)
    const updated = await ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: () => AgendaStore.update("home", legacy.id, { title: "Renamed wake" }),
    })
    expect(updated.origin).toEqual(current.origin)
    expect(updated.state).toEqual(current.state)
    const persisted = await Storage.read<typeof current>(key)
    expect(persisted.origin).toEqual(current.origin)
    expect(persisted.future).toBe(legacy.future)
    expect(await Storage.read<unknown>(StoragePath.metaMigrationLogDomain("agenda"))).toEqual({
      "20261012-agenda-home-scope": 1,
    })
  })
})

test("Agenda origin normalization leaves project selection and explicit null workspace intact", async () => {
  await using runtime = await testRuntime({ register: registerAgendaMigrations })
  await runtime.run(async () => {
    const record = {
      id: "project-task",
      origin: {
        scope: {
          type: "project",
          id: "project",
          local: { directory: "/project", worktree: "/project", sandboxes: [] },
          future: 1,
        },
        workspaceID: null,
      },
    }
    expect(upgradeImportedRecord(["agenda", "items", "home", record.id], record)).toEqual(record)
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
