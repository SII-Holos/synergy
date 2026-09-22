import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { openLocalRuntime } from "../src"

test("startup upgrades only Scope metadata; Session access upgrades its binding and preserves unrelated history", async () => {
  await using fixture = await runtimeHome()
  const directory = path.join(fixture.host.home, "project")
  await fs.mkdir(directory)
  const runtime = await openLocalRuntime({ host: fixture.host, mode: "oneshot" })
  let scopeID = ""
  let sessionID = ""
  let legacy: Record<string, unknown> = {}
  const evidence = { run: "historical", opaque: [1, { unknown: "preserved" }] }
  try {
    await runtime.run(async () => {
      const { scope } = await Scope.fromDirectory(directory)
      scopeID = scope.id
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const session = await Session.create({ title: "Archived work", workspace: null })
          sessionID = session.id
          const { local, ...metadata } = scope
          const oldScope = { ...metadata, ...local, privateExtension: { revision: 7 } }
          const { workspaceID: _workspaceID, ...legacySession } = session
          legacy = {
            ...legacySession,
            scope: oldScope,
            workspace: undefined,
            futureExtension: { preserve: true },
            time: { ...session.time, archived: 123 },
          }
          await Storage.removeTree(["sessions", scopeID, sessionID, "migrations"])
          await Storage.write(["sessions", scopeID, sessionID, "info"], legacy)
          await Storage.write(["sessions", scopeID, sessionID, "evidence", "record"], evidence)
          await Storage.write(StoragePath.scope(Identifier.asScopeID(scopeID)), oldScope)
          await Storage.update<Record<string, number>>(StoragePath.metaMigrationLogDomain("scope"), (log) => {
            delete log["20260921-scope-local-binding"]
            log["unregistered-owner-history"] = 42
          })
        },
      })
    })
  } finally {
    await runtime.close()
  }
  await fs.rm(directory, { recursive: true })
  await using reopened = await openLocalRuntime({ host: fixture.host, mode: "oneshot" })
  await reopened.run(async () => {
    const scope = await Scope.fromID(scopeID)
    expect(scope?.local?.directory).toBe(directory)
    const storedBefore = await Storage.read<Record<string, unknown>>(["sessions", scopeID, sessionID, "info"])
    expect(storedBefore).toEqual(JSON.parse(JSON.stringify(legacy)))
    expect(
      (await Storage.read<Record<string, number>>(StoragePath.metaMigrationLogDomain("scope")))[
        "unregistered-owner-history"
      ],
    ).toBe(42)
    await ScopeContext.provide({
      scope: scope!,
      fn: async () => {
        const session = await Session.get(sessionID)
        expect(session.scope.local?.directory).toBe(directory)
        expect(session.workspace).toMatchObject({ type: "main", path: directory, scopeID })
        expect(session.workspaceID).toStartWith("wsp_")
        expect(session.time.archived).toBe(123)
        const stored = await Storage.read<Record<string, unknown>>(["sessions", scopeID, sessionID, "info"])
        expect(stored.workspaceID).toBe(session.workspaceID)
        expect(stored).not.toHaveProperty("workspace")
        await expect(Session.assertWorkspaceAvailable(sessionID)).rejects.toThrow("unavailable")
        expect(stored.futureExtension).toEqual({ preserve: true })
        expect((stored.scope as Record<string, unknown>).privateExtension).toEqual({ revision: 7 })
        expect(await Storage.read<typeof evidence>(["sessions", scopeID, sessionID, "evidence", "record"])).toEqual(
          evidence,
        )
        expect((await Session.get(sessionID)).workspace).toEqual(session.workspace)
      },
    })
  })
})
