import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { openLocalRuntime } from "../../src"
import { testRuntime } from "../support/runtime"

test("Home default identity and files survive reopening while old explicit null sessions stay null", async () => {
  await using fixture = await runtimeHome()
  let workspaceID: string | null | undefined
  let noneID = ""
  let filename = ""
  {
    await using runtime = await openLocalRuntime({ host: fixture.host, mode: "oneshot" })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const none = await Session.create({ workspace: null })
          noneID = none.id
          expect(
            await fs.stat(path.join(fixture.host.root, "workspaces", "home")).catch(() => undefined),
          ).toBeUndefined()
          const [first, second] = await Promise.all([Session.create(), Session.create()])
          expect(second.workspaceID).toBe(first.workspaceID)
          workspaceID = first.workspaceID
          filename = path.join(first.workspace!.path, "retained.txt")
          await Bun.write(filename, "Home work survives restart")
        },
      }),
    )
  }
  await using reopened = await openLocalRuntime({ host: fixture.host, mode: "oneshot" })
  await reopened.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        expect((await Session.create()).workspaceID).toBe(workspaceID)
        expect(await Bun.file(filename).text()).toBe("Home work survives restart")
        expect((await Session.get(noneID)).workspaceID).toBeNull()
        expect((await Session.applyWorkspaceSelection(noneID, { mode: "current" })).workspace).toBeNull()
        expect((await Session.create({ parentID: noneID })).workspace).toBeNull()
      },
    }),
  )
})

test("interleaved Runtime homes own separate default directories and IDs", async () => {
  await using first = await testRuntime()
  await using second = await testRuntime()
  const create = () => ScopeContext.provide({ scope: Scope.home(), fn: () => Session.create() })
  const a = await first.run(create)
  const b = await second.run(create)
  expect(a.workspace?.path).toBe(await fs.realpath(path.join(first.host.root, "workspaces", "home")))
  expect(b.workspace?.path).toBe(await fs.realpath(path.join(second.host.root, "workspaces", "home")))
  expect(b.workspaceID).not.toBe(a.workspaceID)
  expect((await first.run(create)).workspaceID).toBe(a.workspaceID)
})

test("an unusable Home default path fails creation instead of falling back to the user directory", async () => {
  await using runtime = await testRuntime()
  await fs.writeFile(path.join(runtime.host.root, "workspaces"), "not a directory")
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        await expect(Session.create()).rejects.toMatchObject({ code: "ENOTDIR" })
        expect((await Session.create({ workspace: null })).workspace).toBeNull()
      },
    }),
  )
})
