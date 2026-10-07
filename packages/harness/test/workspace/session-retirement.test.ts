import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionManager } from "../../src/session/manager"
import { SessionSchemaRegistry } from "../../src/session/schema-registry"
import { SessionWorkspaceRuntime } from "../../src/session/workspace-runtime"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { WorkspaceBinding } from "../../src/workspace/binding"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

test("retiring native Workspaces reject new references but permit history, metadata and migration away", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using files = await tmpdir()
    const scope = await files.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const historical = await Session.create()
        const migrating = await Session.create({ workspaceID: historical.workspaceID })
        const selecting = await Session.create({ workspace: null })
        const original = await WorkspaceCatalog.get(historical.workspaceID!, scope.id)
        const destination = await WorkspaceCatalog.create({
          scopeID: scope.id,
          backend: { provider: "objects", spec: {} },
        })
        const owned = await WorkspaceCatalog.beginRetirement([original])
        const projection = WorkspaceCatalog.projection(owned[0]!)!

        await expect(Session.create({ workspaceID: original.id })).rejects.toMatchObject({
          name: "WorkspaceUnavailable",
        })
        await expect(Session.create({ workspace: projection })).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
        await expect(Session.create({ parentID: historical.id })).rejects.toMatchObject({
          name: "WorkspaceUnavailable",
        })
        await expect(Session.fork({ sessionID: historical.id })).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
        await expect(Session.updateWorkspace(selecting.id, projection)).rejects.toMatchObject({
          name: "WorkspaceUnavailable",
        })
        expect((await Session.get(selecting.id)).workspaceID).toBeNull()
        expect((await WorkspaceBinding.adopt(projection, scope.id))?.lifecycle).toBe("deleting")
        expect(await Session.messages({ sessionID: historical.id })).toEqual([])
        await Session.update(historical.id, (draft) => {
          draft.title = "Historical title"
          draft.tags = ["retained"]
        })
        await Session.update(historical.id, (draft) => {
          draft.time.archived = Date.now()
        })
        expect(await Session.get(historical.id)).toMatchObject({
          title: "Historical title",
          tags: ["retained"],
          workspaceID: original.id,
          workspace: { lifecycle: "deleting" },
        })
        await Session.updateWorkspace(migrating.id, null, {
          reference: { workspaceID: destination.id, workspaceGeneration: destination.binding.generation },
        })
        expect((await Session.get(migrating.id)).workspaceID).toBe(destination.id)

        const deleted = await WorkspaceCatalog.completeRetirement(owned, "deleted")
        await expect(
          Session.updateWorkspace(selecting.id, WorkspaceCatalog.projection(deleted[0]!)!),
        ).rejects.toMatchObject({
          name: "WorkspaceUnavailable",
        })
        await expect(Session.create({ workspaceID: original.id })).rejects.toMatchObject({
          name: "WorkspaceUnavailable",
        })
        await Session.update(historical.id, (draft) => {
          draft.title = "Deleted Workspace history"
        })
        expect((await Session.get(historical.id)).workspace?.lifecycle).toBe("deleted")
        await Session.updateWorkspace(historical.id, null)
        expect((await Session.get(historical.id)).workspaceID).toBeNull()

        const rollingBack = await WorkspaceCatalog.beginRetirement([destination])
        const [restored] = await WorkspaceCatalog.completeRetirement(rollingBack, "active")
        expect((await Session.create({ workspaceID: restored!.id })).workspaceID).toBe(restored!.id)
        await Session.updateWorkspace(selecting.id, null, {
          reference: { workspaceID: restored!.id, workspaceGeneration: restored!.binding.generation },
        })
        expect((await Session.get(selecting.id)).workspaceID).toBe(restored!.id)
      },
    })
  })
})

test.each(["directory", "objects"] as const)(
  "SessionManager rejects a retiring canonical %s binding and permits explicit history execution",
  async (backend) => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using files = await tmpdir()
      const scope = await files.scope()
      await ScopeContext.provide({
        scope,
        fn: async () => {
          const original =
            backend === "directory"
              ? await WorkspaceBinding.register(scope.id, files.path)
              : await WorkspaceCatalog.create({ scopeID: scope.id, backend: { provider: "objects", spec: {} } })
          const session = await Session.create({ workspaceID: original.id })
          if (backend === "objects") expect(session.workspace).toBeNull()
          const owned = await WorkspaceCatalog.beginRetirement([original])
          let ran = false
          await expect(
            SessionManager.run(
              session.id,
              async () => {
                ran = true
              },
              { requestNextWorkOnFailure: false },
            ),
          ).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
          expect(ran).toBe(false)
          expect(SessionManager.isRunning(session.id)).toBe(false)
          expect(await SessionManager.run(session.id, async () => "history", { workspace: "history" })).toBe("history")
          await WorkspaceCatalog.completeRetirement(owned, "deleted")
          await expect(
            SessionManager.run(session.id, async () => "forbidden", { requestNextWorkOnFailure: false }),
          ).rejects.toMatchObject({
            name: "WorkspaceUnavailable",
          })
          expect(await SessionManager.run(session.id, async () => "deleted history", { workspace: "history" })).toBe(
            "deleted history",
          )
        },
      })
    })
  },
)

test("SessionManager rejects missing canonical metadata without blocking history or unbound Sessions", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const workspace = await WorkspaceCatalog.create({ scopeID: "home", backend: { provider: "objects", spec: {} } })
        const session = await Session.create({ workspaceID: workspace.id })
        await Storage.remove(StoragePath.workspace(workspace.id))
        expect((await Session.get(session.id)).workspace).toBeNull()
        await expect(
          SessionManager.run(session.id, async () => "forbidden", { requestNextWorkOnFailure: false }),
        ).rejects.toMatchObject({ name: "NotFoundError" })
        expect(await SessionManager.run(session.id, async () => "history", { workspace: "history" })).toBe("history")
        const unbound = await Session.create({ workspace: null })
        expect(await SessionManager.run(unbound.id, async () => "unbound")).toBe("unbound")
      },
    }),
  )
})

test("Session creation rechecks a stale pre-read inside the publication writer transaction", async () => {
  const preRead = Promise.withResolvers<void>()
  await using runtime = await testRuntime({
    register: () => {
      SessionSchemaRegistry.register("retirement-barrier", {
        shape: {},
        isBackground(input) {
          if (input.title === "stale pre-read") preRead.resolve()
          return false
        },
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const workspace = await WorkspaceCatalog.create({ scopeID: "home", backend: { provider: "objects", spec: {} } })
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const writer = Storage.transaction(async () => {
          entered.resolve()
          await release.promise
          await WorkspaceCatalog.beginRetirement([workspace])
        })
        let creation: Promise<unknown> | undefined
        const sessionID = Identifier.descending("session")
        const rescue = setTimeout(() => {
          release.resolve()
          preRead.reject(new Error("Session creation did not reach the pre-publication barrier"))
        }, 2000)
        try {
          await entered.promise
          creation = Session.create({ id: sessionID, title: "stale pre-read", workspaceID: workspace.id }).then(
            () => "unexpected publication",
            (error: unknown) => error,
          )
          await preRead.promise
          expect((await WorkspaceCatalog.get(workspace.id, "home")).lifecycle).toBe("active")
          release.resolve()
          await writer
          expect(await creation).toMatchObject({ name: "WorkspaceUnavailable" })
          expect(
            await Storage.readMany([
              StoragePath.sessionInfo(Identifier.asScopeID("home"), Identifier.asSessionID(sessionID)),
              StoragePath.sessionIndex(Identifier.asSessionID(sessionID)),
            ]),
          ).toEqual([undefined, undefined])
        } finally {
          clearTimeout(rescue)
          release.resolve()
          await writer
          await creation
        }
      },
    }),
  )
})

test("Workspace selection rechecks retirement after a real transition hook and before publication", async () => {
  let destination: WorkspaceCatalog.Info | undefined
  await using runtime = await testRuntime({
    register: () => {
      SessionWorkspaceRuntime.registerTransition("retirement-barrier", async () => {
        if (destination) await WorkspaceCatalog.beginRetirement([destination])
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({ workspace: null })
        destination = await WorkspaceCatalog.create({ scopeID: "home", backend: { provider: "objects", spec: {} } })
        await expect(
          Session.updateWorkspace(session.id, null, {
            reference: { workspaceID: destination.id, workspaceGeneration: destination.binding.generation },
          }),
        ).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
        expect((await Session.get(session.id)).workspaceID).toBeNull()
        expect((await WorkspaceCatalog.get(destination.id, "home")).lifecycle).toBe("deleting")
      },
    }),
  )
})
