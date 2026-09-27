import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { FileMutation } from "../../src/file/mutation"
import { testRuntime } from "../support/runtime"

test("an active Session moves its native ownership and execution context to the selected Workspace", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    await using c = await tmpdir()
    const scope = await a.scope()
    const session = await ScopeContext.provide({ scope, fn: () => Session.create() })
    const original = await WorkspaceCatalog.get(session.workspaceID!, scope.id)
    const next = await WorkspaceBinding.register(scope.id, b.path)
    await SessionManager.run(session.id, async () => {
      await FileMutation.write({ path: path.join(a.path, "before"), content: "before", expectedVersion: null })
      await Session.updateWorkspace(session.id, WorkspaceCatalog.projection(next))
      expect(ScopeContext.current.workspace?.id).toBe(next.id)
      expect(ScopeContext.current.directory).toBe(b.path)
      await WorkspaceBinding.rebind(original.id, {
        scopeID: scope.id,
        expectedRevision: original.revision,
        path: c.path,
      })
      await FileMutation.write({ path: path.join(b.path, "after"), content: "after", expectedVersion: null })
      await expect(WorkspaceAccess.exclusive([b.path], async () => {})).rejects.toThrow("busy")
    })
    expect(await Bun.file(path.join(b.path, "after")).text()).toBe("after")
    await WorkspaceAccess.exclusive([b.path], async () => {})
  })
})

test("switching is rejected while a parallel native write is admitted", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    const scope = await a.scope()
    const session = await ScopeContext.provide({ scope, fn: () => Session.create() })
    const next = await WorkspaceBinding.register(scope.id, b.path)
    await SessionManager.run(session.id, async () => {
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const writing = WorkspaceAccess.write([a.path], async () => {
        started.resolve()
        await release.promise
      })
      try {
        await started.promise
        await expect(Session.updateWorkspace(session.id, WorkspaceCatalog.projection(next))).rejects.toThrow(
          "in flight",
        )
        expect((await Session.get(session.id)).workspaceID).toBe(session.workspaceID!)
        expect(ScopeContext.current.workspace?.id).toBe(session.workspaceID!)
      } finally {
        release.resolve()
        await writing
      }
      await Session.updateWorkspace(session.id, WorkspaceCatalog.projection(next))
      expect(ScopeContext.current.workspace?.id).toBe(next.id)
    })
  })
})

test("a failed binding write leaves the old Task context and releases the destination pin", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    const scope = await a.scope()
    const session = await ScopeContext.provide({ scope, fn: () => Session.create() })
    const next = await WorkspaceBinding.register(scope.id, b.path)
    await SessionManager.run(session.id, async () => {
      const originalWrite = Storage.write
      using _write = spyOn(Storage, "write").mockImplementation(async (key, value) => {
        if (key[0] === "sessions" && key[2] === session.id && key[3] === "info") throw new Error("storage failed")
        return originalWrite(key, value)
      })
      await expect(Session.updateWorkspace(session.id, WorkspaceCatalog.projection(next))).rejects.toThrow(
        "storage failed",
      )
      expect(ScopeContext.current.workspace?.id).toBe(session.workspaceID!)
      await WorkspaceAccess.exclusive([b.path], async () => {})
      await FileMutation.write({ path: path.join(a.path, "kept"), content: "kept", expectedVersion: null })
    })
    expect((await Session.get(session.id)).workspaceID).toBe(session.workspaceID!)
  })
})

test("another execution context cannot replace a running Session binding", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    const scope = await a.scope()
    const session = await ScopeContext.provide({ scope, fn: () => Session.create() })
    const next = await WorkspaceBinding.register(scope.id, b.path)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const running = SessionManager.run(session.id, async () => {
      started.resolve()
      await release.promise
      expect(ScopeContext.current.workspace?.id).toBe(session.workspaceID!)
    })
    try {
      await started.promise
      await expect(
        ScopeContext.provide({
          scope,
          fn: () => Session.updateWorkspace(session.id, WorkspaceCatalog.projection(next)),
        }),
      ).rejects.toThrow("is busy")
      expect((await Session.get(session.id)).workspaceID).toBe(session.workspaceID!)
    } finally {
      release.resolve()
      await running
    }
  })
})

test("a stale destination generation cannot silently select its new directory", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    await using c = await tmpdir()
    const scope = await a.scope()
    const session = await ScopeContext.provide({ scope, fn: () => Session.create() })
    const selected = await WorkspaceBinding.register(scope.id, b.path)
    await WorkspaceBinding.rebind(selected.id, {
      scopeID: scope.id,
      expectedRevision: selected.revision,
      path: c.path,
    })
    await SessionManager.run(session.id, async () => {
      await expect(Session.updateWorkspace(session.id, WorkspaceCatalog.projection(selected))).rejects.toMatchObject({
        name: "WorkspaceBindingChanged",
      })
      expect(ScopeContext.current.workspace?.id).toBe(session.workspaceID!)
      expect((await Session.get(session.id)).workspaceID).toBe(session.workspaceID!)
    })
  })
})

test("a generic Session editor cannot bypass the Workspace transition", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    const scope = await a.scope()
    const next = await WorkspaceBinding.register(scope.id, b.path)
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create()
        await expect(
          Session.update(session.id, (draft) => {
            draft.workspace = WorkspaceCatalog.projection(next)
            draft.workspaceID = next.id
          }),
        ).rejects.toThrow("Session.updateWorkspace")
        expect((await Session.get(session.id)).workspaceID).toBe(session.workspaceID!)
      },
    })
  })
})

test("an existing process retains the old binding while the Task switches", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    const scope = await a.scope()
    const session = await ScopeContext.provide({ scope, fn: () => Session.create() })
    const next = await WorkspaceBinding.register(scope.id, b.path)
    await SessionManager.run(session.id, async () => {
      const process = await WorkspaceAccess.process([])
      try {
        await Session.updateWorkspace(session.id, WorkspaceCatalog.projection(next))
        await expect(WorkspaceAccess.exclusive([a.path], async () => {})).rejects.toThrow("busy")
        expect(ScopeContext.current.workspace?.id).toBe(next.id)
      } finally {
        await process.release()
      }
      await WorkspaceAccess.exclusive([a.path], async () => {})
    })
  })
})

test("cancelling a switch queued behind destination maintenance leaves canonical ownership unchanged", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    const scope = await a.scope()
    const session = await ScopeContext.provide({ scope, fn: () => Session.create() })
    const next = await WorkspaceBinding.register(scope.id, b.path)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const maintenance = WorkspaceAccess.exclusive([b.path], async () => {
      started.resolve()
      await release.promise
    })
    try {
      await started.promise
      await SessionManager.run(session.id, async () => {
        const switching = Session.updateWorkspace(session.id, WorkspaceCatalog.projection(next))
        SessionManager.signalAbort(session.id)
        await expect(switching).rejects.toMatchObject({ name: "AbortError" })
        expect(ScopeContext.current.workspace?.id).toBe(session.workspaceID!)
      })
    } finally {
      release.resolve()
      await maintenance
    }
    expect((await Session.get(session.id)).workspaceID).toBe(session.workspaceID!)
    await WorkspaceAccess.exclusive([a.path, b.path], async () => {})
  })
})

test("a Task can leave a Workspace whose directory disappeared without granting writes there", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    const scope = await a.scope()
    const session = await ScopeContext.provide({ scope, fn: () => Session.create() })
    const next = await WorkspaceBinding.register(scope.id, b.path)
    await SessionManager.run(session.id, async () => {
      await fs.rm(a.path, { recursive: true })
      await Session.updateWorkspace(session.id, WorkspaceCatalog.projection(next))
      expect(ScopeContext.current.workspace?.id).toBe(next.id)
      await FileMutation.write({ path: path.join(b.path, "recovered"), content: "ok", expectedVersion: null })
    })
    expect((await Session.get(session.id)).workspaceID).toBe(next.id)
    expect(await Bun.file(path.join(b.path, "recovered")).text()).toBe("ok")
  })
})
