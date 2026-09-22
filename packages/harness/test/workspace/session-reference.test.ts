import { expect, test } from "bun:test"
import { Session } from "../../src/session"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { SessionExport } from "../../src/session/session-export"
import { SessionImport } from "../../src/session/session-import"

test("sessions persist a shared Workspace reference and read its current location", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using files = await tmpdir()
    await using moved = await tmpdir()
    const scope = await files.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })
        expect(parent.workspaceID).toStartWith("wsp_")
        expect(child.workspaceID).toBe(parent.workspaceID)
        const stored = await Storage.read<Record<string, unknown>>(["sessions", scope.id, parent.id, "info"])
        expect(stored.workspaceID).toBe(parent.workspaceID)
        expect(stored).not.toHaveProperty("workspace")
        const workspace = await WorkspaceCatalog.get(parent.workspaceID!, scope.id)
        await WorkspaceCatalog.rebind(workspace.id, {
          scopeID: scope.id,
          expectedRevision: workspace.revision,
          hostID: workspace.binding.hostID,
          path: moved.path,
        })
        expect((await Session.get(child.id)).workspace?.path).toBe(moved.path)
        await Session.update(parent.id, (draft) => {
          draft.title = "Updated title"
        })
        expect((await Session.get(parent.id)).workspace?.path).toBe(moved.path)
        expect(await Storage.read(["sessions", scope.id, parent.id, "info"])).not.toHaveProperty("workspace")
        const empty = await Session.create({ workspace: null })
        expect(empty.workspaceID).toBeNull()
        expect(empty.workspace).toBeNull()
        await Session.remove(parent.id)
        await Session.remove(empty.id)
      },
    })
  })
})

test("transcript import preserves Workspace history without granting filesystem access", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using files = await tmpdir()
    const scope = await files.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const parent = await Session.create({})
        await Session.create({ parentID: parent.id })
        const report = await SessionExport.generate({ sessionID: parent.id, mode: "full" })
        expect(report.workspaces).toHaveLength(1)
        const imported = await SessionImport.fromBuffer(new TextEncoder().encode(JSON.stringify(report)))
        const first = imported.sessions[0]!.session
        expect(first.workspaceID).toBeTruthy()
        expect(first.workspaceID).not.toBe(parent.workspaceID)
        expect(imported.sessions.every((item) => item.session.workspaceID === first.workspaceID)).toBe(true)
        expect(first.workspace?.path).toBe(files.path)
        await expect(Session.assertWorkspaceAvailable(first.id)).rejects.toThrow("binding")
        expect(await Storage.read(["sessions", scope.id, first.id, "info"])).not.toHaveProperty("workspace")
        await Session.assertWorkspaceAvailable(parent.id)
        const exported = await SessionExport.generate({ sessionID: first.id, mode: "full" })
        expect(exported.workspaces?.[0]?.binding.state).toBe("unbound")
        await Session.remove(parent.id)
        await Session.remove(first.id)
      },
    })
  })
})
