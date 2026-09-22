import { expect, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"

test("write grants are explicit, direct, Scope-bound and separate from binding generation", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    await using c = await tmpdir()
    const scope = await a.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const first = await WorkspaceBinding.register(scope.id, a.path)
        const second = await WorkspaceBinding.register(scope.id, b.path)
        const third = await WorkspaceBinding.register(scope.id, c.path)
        const selected = WorkspaceCatalog.projection(first)
        expect(await WorkspaceBinding.writableRoots(selected)).toEqual([a.path])
        await WorkspaceBinding.setSharing(second.id, {
          scopeID: scope.id,
          expectedRevision: second.revision,
          workspaceIDs: [third.id],
        })
        const updated = await WorkspaceBinding.setSharing(first.id, {
          scopeID: scope.id,
          expectedRevision: first.revision,
          workspaceIDs: [second.id, second.id],
        })
        expect(updated.sharedWritableWorkspaceIDs).toEqual([second.id])
        expect(updated.revision).toBe(first.revision + 1)
        expect(updated.binding.generation).toBe(first.binding.generation)
        expect(await WorkspaceBinding.writableRoots(selected)).toEqual([a.path, b.path])
        await expect(
          WorkspaceBinding.setSharing(first.id, {
            scopeID: scope.id,
            expectedRevision: first.revision,
            workspaceIDs: [],
          }),
        ).rejects.toThrow()
        await expect(
          WorkspaceBinding.setSharing(first.id, {
            scopeID: scope.id,
            expectedRevision: updated.revision,
            workspaceIDs: [first.id],
          }),
        ).rejects.toThrow()
        const foreign = await WorkspaceBinding.register((await c.scope()).id, b.path)
        await expect(
          WorkspaceBinding.setSharing(first.id, {
            scopeID: scope.id,
            expectedRevision: updated.revision,
            workspaceIDs: [foreign.id],
          }),
        ).rejects.toThrow()
      },
    })
  })
})

test("sharing changes cannot race an active Workspace user", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()
    const record = await WorkspaceBinding.register(scope.id, tmp.path)
    await WorkspaceAccess.task({ workspace: WorkspaceCatalog.projection(record) }, async () => {
      await expect(
        WorkspaceBinding.setSharing(record.id, {
          scopeID: scope.id,
          expectedRevision: record.revision,
          workspaceIDs: [],
        }),
      ).rejects.toThrow("busy")
    })
    expect((await WorkspaceCatalog.get(record.id, scope.id)).revision).toBe(record.revision)
  })
})

test("shared directories remain in use until the Session turn ends", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()
    await using c = await tmpdir()
    const scope = await a.scope()
    const first = await WorkspaceBinding.register(scope.id, a.path)
    const second = await WorkspaceBinding.register(scope.id, b.path)
    await WorkspaceBinding.setSharing(first.id, {
      scopeID: scope.id,
      expectedRevision: first.revision,
      workspaceIDs: [second.id],
    })
    await WorkspaceAccess.task({ workspace: WorkspaceCatalog.projection(first) }, async () => {
      await WorkspaceBinding.writableRoots(WorkspaceCatalog.projection(first))
      await expect(
        WorkspaceBinding.rebind(second.id, { scopeID: scope.id, expectedRevision: second.revision, path: c.path }),
      ).rejects.toThrow("busy")
    })
    const rebound = await WorkspaceBinding.rebind(second.id, {
      scopeID: scope.id,
      expectedRevision: second.revision,
      path: c.path,
    })
    expect(rebound.id).toBe(second.id)
    expect(rebound.binding.generation).toBe(second.binding.generation + 1)
    expect(await WorkspaceBinding.writableRoots(WorkspaceCatalog.projection(first))).toEqual([a.path, c.path])
  })
})
