import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Scope } from "../../src/scope"
import { WorkspaceBinding } from "../../src/workspace/binding"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { WorkspaceLocation } from "../../src/workspace/location"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"

test.each(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"])(
  "historical Workspace migration retains %s paths without admitting file access",
  async (code) => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      const directory = path.join(runtime.host.home, "unavailable")
      const workspace = { scopeID: "project", type: "directory", path: directory, retained: true }
      const source = WorkspaceLocation.source()
      const failure = Object.assign(new Error("unavailable historical directory"), { code })
      using inspection = spyOn(source, "identify").mockRejectedValue(failure)
      const migrated = await WorkspaceBinding.migrate(workspace, workspace.scopeID)
      expect(migrated).toMatchObject({ ...workspace, generation: 1 })
      const record = await WorkspaceCatalog.get(migrated!.id!, workspace.scopeID)
      expect(record.binding.physicalID).toBeUndefined()
      await expect(WorkspaceBinding.validate(record.id, workspace.scopeID)).rejects.toMatchObject({
        name: "WorkspaceUnavailable",
        data: { reason: "identity_unverified" },
      })
      await expect(WorkspaceBinding.register(workspace.scopeID, directory)).rejects.toBe(failure)
      await expect(WorkspaceBinding.adopt(workspace, workspace.scopeID)).rejects.toBe(failure)
      expect(await WorkspaceBinding.migrate(workspace, workspace.scopeID)).toEqual(migrated)
      expect(await WorkspaceCatalog.get(record.id, workspace.scopeID)).toEqual(record)
    })
  },
)

test("historical descriptors preserve replaced bindings, including canonical directory aliases", async () => {
  await using runtime = await testRuntime()
  const directory = await fs.realpath(runtime.host.home)
  const alias = path.join(directory, "alias")
  await fs.symlink(directory, alias, "junction")
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(alias)
    const source = WorkspaceLocation.source()
    const record = await WorkspaceCatalog.register({
      scopeID: scope.id,
      hostID: await source.hostID(),
      type: "directory",
      path: directory,
      physicalID: "previous-volume:inode:birth",
      metadata: { retained: true },
    })
    for (const location of [directory, alias]) {
      expect(
        await WorkspaceBinding.migrate({ type: "directory", scopeID: scope.id, path: location }, scope.id),
      ).toEqual(WorkspaceCatalog.projection(record))
      await expect(
        WorkspaceBinding.adopt({ type: "directory", scopeID: scope.id, path: location }, scope.id),
      ).rejects.toMatchObject({
        name: "WorkspaceUnavailable",
      })
    }
    expect(await WorkspaceBinding.describeDefault(scope)).toEqual(WorkspaceCatalog.projection(record))
    expect(await WorkspaceCatalog.get(record.id, scope.id)).toEqual(record)
    await expect(WorkspaceBinding.validate(record.id, scope.id)).rejects.toMatchObject({
      name: "WorkspaceUnavailable",
      data: { reason: "identity_changed" },
    })
  })
})

test("unexpected identity failures and invalid history remain errors without publishing bindings", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const workspace = { scopeID: "project", type: "directory", path: runtime.host.home }
    const source = WorkspaceLocation.source()
    const failure = Object.assign(new Error("identity provider failed"), { code: "EIO" })
    using inspection = spyOn(source, "identify").mockRejectedValue(failure)
    await expect(WorkspaceBinding.migrate(workspace, workspace.scopeID)).rejects.toBe(failure)
    await expect(WorkspaceBinding.migrate(workspace, "other")).rejects.toThrow("different Scope")
    await expect(WorkspaceBinding.migrate({ ...workspace, path: "relative" }, workspace.scopeID)).rejects.toThrow(
      "absolute",
    )
    expect(await WorkspaceCatalog.list(workspace.scopeID)).toEqual([])
  })
})

test("retained history reads do not wait for an unrelated storage writer", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const workspace = { scopeID: "project", type: "directory", path: runtime.host.home }
    const original = await WorkspaceBinding.migrate(workspace, workspace.scopeID)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const writer = Storage.transaction(async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      expect(
        await Promise.race([
          WorkspaceBinding.migrate(workspace, workspace.scopeID),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("History read waited for the writer")), 2000)
          }),
        ]),
      ).toEqual(original)
    } finally {
      clearTimeout(timer)
      release.resolve()
      await writer
    }
  })
})
