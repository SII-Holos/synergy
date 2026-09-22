import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { WorkspaceBinding } from "../../src/workspace/binding"
import { Session } from "../../src/session"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"
import { SessionExport } from "../../src/session/session-export"
import { SessionImport } from "../../src/session/session-import"
import { SessionManager } from "../../src/session/manager"

test("creation, children and forks preserve an unresolved Workspace reference", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using files = await tmpdir()
    const scope = await files.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const missing = await WorkspaceCatalog.importMissingReference("wsp_unresolved", scope.id)
        const parent = await Session.create({ workspaceID: missing.id })
        const child = await Session.create({ parentID: parent.id })
        const fork = await Session.fork({ sessionID: parent.id })
        for (const session of [parent, child, fork]) {
          expect(session.workspaceID).toBe(missing.id)
          expect(session.workspace).toBeNull()
          expect(await Session.get(session.id)).toMatchObject({ workspaceID: missing.id, workspace: null })
          let ran = false
          await expect(
            SessionManager.run(session.id, async () => {
              ran = true
            }),
          ).rejects.toThrow()
          expect(ran).toBe(false)
        }
        const unbound = await Session.create({ parentID: parent.id, workspace: null })
        expect(unbound.workspaceID).toBeNull()
        expect(unbound.workspace).toBeNull()
      },
    })
  })
})

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

test("transcripts include and remap every historical Workspace without inheriting local authority", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using files = await tmpdir()
    await using historical = await tmpdir()
    const scope = await files.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        const history = await WorkspaceBinding.register(scope.id, historical.path)
        const source = { id: history.id, generation: history.binding.generation, root: historical.path }
        const userID = Identifier.ascending("message")
        const assistantID = Identifier.ascending("message")
        await Session.updateMessage({
          id: userID,
          sessionID: session.id,
          role: "user",
          time: { created: 1 },
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
          summary: { title: "History", diffs: [{ file: "same.txt", workspace: source, additions: 1, deletions: 0 }] },
        })
        await Session.updateMessage({
          id: assistantID,
          sessionID: session.id,
          role: "assistant",
          parentID: userID,
          time: { created: 2, completed: 3 },
          modelID: "test",
          providerID: "test",
          mode: "build",
          agent: "synergy",
          path: { cwd: historical.path, root: historical.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantID,
          sessionID: session.id,
          type: "patch",
          hash: "a".repeat(40),
          workspace: source,
          files: [historical.path + "/same.txt"],
        })
        await Storage.write(
          ["sessions", scope.id, session.id, "summary"],
          [{ file: "same.txt", workspace: source, additions: 1, deletions: 0 }],
        )
        const report = await SessionExport.generate({ sessionID: session.id, mode: "full" })
        expect(report.workspaces?.map((entry) => entry.id).sort()).toEqual([session.workspaceID!, history.id].sort())
        const imported = await SessionImport.fromReport(report)
        const messages = await Session.messages({ sessionID: imported.rootSessionID, raw: true })
        const patch = messages.flatMap((message) => message.parts).find((part) => part.type === "patch")!
        if (patch.type !== "patch") throw new Error("Expected patch")
        expect(patch.workspace?.id).not.toBe(source.id)
        expect(patch.workspace?.generation).toBe(source.generation)
        expect(patch.workspace?.root).toBe(source.root)
        const record = await WorkspaceCatalog.get(patch.workspace!.id, scope.id)
        expect(record.binding.state).toBe("unbound")
        await expect(WorkspaceBinding.validate(patch.workspace!.id, scope.id, source.generation)).rejects.toThrow()
        expect(messages[0]!.info.role === "user" && messages[0]!.info.summary?.diffs[0]?.workspace?.id).toBe(record.id)
        expect((await Session.diff(imported.rootSessionID))[0]?.workspace?.id).toBe(record.id)
        expect((await WorkspaceCatalog.get(source.id, scope.id)).binding.state).toBe("bound")
        await Session.remove(imported.rootSessionID)
        await Session.remove(session.id)
      },
    })
  })
})

test("an imported unresolved Workspace cannot adopt an existing local identity", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using files = await tmpdir()
    const scope = await files.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const source = await Session.create({})
        const report = await SessionExport.generate({ sessionID: source.id, mode: "full" })
        report.workspaces = []
        report.sessions[0]!.info.workspace = null
        const result = await SessionImport.fromReport(report)
        const imported = await Session.get(result.rootSessionID)
        expect(imported.workspaceID).not.toBe(source.workspaceID)
        expect(imported.workspaceID).toBeTruthy()
        expect(imported.workspace).toBeNull()
        await expect(Session.assertWorkspaceAvailable(imported.id)).rejects.toThrow()
        const record = await WorkspaceCatalog.get(imported.workspaceID!, scope.id)
        expect(record.binding.path).toBeNull()
        expect(record.importedFrom?.workspaceID).toBe(source.workspaceID!)
        const exported = await SessionExport.generate({ sessionID: imported.id, mode: "full" })
        expect(exported.workspaces?.[0]?.binding.path).toBeNull()
        await Session.assertWorkspaceAvailable(source.id)
        await Session.remove(imported.id)
        await Session.remove(source.id)
      },
    })
  })
})
