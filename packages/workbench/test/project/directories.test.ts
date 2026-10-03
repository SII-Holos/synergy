import { expect, spyOn, test } from "bun:test"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"
import { ProjectDirectories } from "../../src/project/directories"
import { ProjectDirectoriesRoute } from "../../src/project/routes/directories"

test("unavailable project folders retain identity failure reasons and recover through explicit rebinding", async () => {
  await using runtime = await testRuntime()
  await using main = await tmpdir({ git: true })
  await using extra = await tmpdir()
  await runtime.run(async () => {
    const created = await ProjectDirectories.create({
      name: "Recovery",
      directories: [main.path, extra.path],
      mainDirectory: main.path,
    })
    const records = await WorkspaceCatalog.list(created.scope.id)
    for (const record of records)
      await Storage.write(StoragePath.workspace(record.id), {
        ...record,
        binding: { ...record.binding, physicalID: "legacy-mount:old-inode:old-birth" },
      })
    const unavailable = await ProjectDirectories.get(created.scope.id)
    const app = new Hono().route("/global/project", ProjectDirectoriesRoute())
    const response = await app.request(`/global/project/${created.scope.id}/directories`)
    expect(response.status).toBe(200)
    expect(ProjectDirectories.Result.parse(await response.json())).toEqual(unavailable)
    const spec = await generateSpecs(app)
    expect(spec.paths?.["/global/project/{scopeID}/directories"]?.get?.operationId).toBe("project.directories")
    expect(spec.components?.schemas?.ProjectFolder).toMatchObject({
      properties: { unavailable: { $ref: "#/components/schemas/WorkspaceUnavailable" } },
    })
    expect(unavailable.folders).toHaveLength(2)
    for (const folder of unavailable.folders)
      expect(folder).toMatchObject({
        available: false,
        git: false,
        unavailable: {
          name: "WorkspaceUnavailable",
          data: { workspaceID: folder.workspaceID, reason: "identity_changed" },
        },
      })
    for (const record of records) {
      const recovered = await WorkspaceBinding.rebind(record.id, {
        scopeID: created.scope.id,
        expectedRevision: record.revision,
        path: record.binding.path!,
      })
      expect(recovered.id).toBe(record.id)
      expect(recovered.sharedWritableWorkspaceIDs).toEqual(record.sharedWritableWorkspaceIDs)
      expect(recovered.binding.generation).toBe(record.binding.generation + 1)
    }
    const recovered = await ProjectDirectories.get(created.scope.id)
    expect(recovered.revision).toBe(created.directories.revision)
    expect(recovered.mainWorkspaceID).toBe(created.directories.mainWorkspaceID)
    expect(recovered.folders.every((folder) => folder.available && !folder.unavailable)).toBe(true)
    expect(recovered.folders.find((folder) => folder.workspaceID === recovered.mainWorkspaceID)?.git).toBe(true)
  })
})

test("unexpected directory validation failures remain request errors", async () => {
  await using runtime = await testRuntime()
  await using directory = await tmpdir()
  await runtime.run(async () => {
    const created = await ProjectDirectories.create({
      name: "Error",
      directories: [directory.path],
      mainDirectory: directory.path,
    })
    using failure = spyOn(WorkspaceBinding, "validate").mockRejectedValue(new Error("storage offline"))
    await expect(ProjectDirectories.get(created.scope.id)).rejects.toThrow("storage offline")
  })
})

test("project creation prepares file configuration outside the storage transaction", async () => {
  await using runtime = await testRuntime()
  await using directory = await tmpdir()
  await runtime.run(async () => {
    const update = Config.domainUpdate
    using preparation = spyOn(Config, "domainUpdate").mockImplementation(async (...args) => {
      expect(Storage.inTransaction()).toBe(false)
      return update(...args)
    })
    const created = await ProjectDirectories.create({
      name: "Prepared project",
      directories: [directory.path],
      mainDirectory: directory.path,
    })
    expect(created.existing).toBe(false)
    expect(preparation).toHaveBeenCalledTimes(1)
    expect(await Scope.fromID(created.scope.id)).toMatchObject({ type: "project", name: "Prepared project" })
  })
})

test("project directories have one mutable main without moving the Scope or existing bindings", async () => {
  await using runtime = await testRuntime()
  await using a = await tmpdir()
  await using b = await tmpdir()
  await runtime.run(async () => {
    const created = await ProjectDirectories.create({
      name: "Example",
      directories: [a.path, b.path],
      mainDirectory: a.path,
    })
    const scopeID = created.scope.id
    const initial = created.directories
    expect(initial.folders).toHaveLength(2)
    const first = await WorkspaceCatalog.get(initial.mainWorkspaceID!, scopeID)
    expect(await WorkspaceBinding.writableRoots(WorkspaceCatalog.projection(first)!)).toEqual([a.path, b.path])
    const changed = await ProjectDirectories.update(scopeID, {
      revision: initial.revision,
      directories: [a.path, b.path],
      mainDirectory: b.path,
    })
    expect(changed.folders.find((item) => item.workspaceID === changed.mainWorkspaceID)?.path).toBe(b.path)
    expect((await Scope.fromID(scopeID))?.local?.directory).toBe(a.path)
    expect((await WorkspaceCatalog.get(first.id, scopeID)).binding).toEqual(first.binding)
    await expect(
      ProjectDirectories.update(scopeID, {
        revision: initial.revision,
        directories: [a.path],
        mainDirectory: a.path,
      }),
    ).rejects.toMatchObject({ name: "ProjectDirectoriesConflict" })
    expect((await ProjectDirectories.get(scopeID)).mainWorkspaceID).toBe(changed.mainWorkspaceID)
    const reopened = await ProjectDirectories.create({
      name: "Do not duplicate",
      directories: [b.path],
      mainDirectory: b.path,
    })
    expect(reopened.existing).toBe(true)
    expect(reopened.scope.id).toBe(scopeID)
    expect(reopened.scope.name).toBe("Example")
  })
})

test("create identifies an existing project without renaming it and never submits an invalid set", async () => {
  await using runtime = await testRuntime()
  await using a = await tmpdir()
  await runtime.run(async () => {
    const first = await ProjectDirectories.create({ name: "Original", directories: [a.path], mainDirectory: a.path })
    const again = await ProjectDirectories.create({
      name: "Do not rename",
      directories: [a.path],
      mainDirectory: a.path,
    })
    expect(again.existing).toBe(true)
    expect(again.scope.name).toBe("Original")
    expect(again.scope.id).toBe(first.scope.id)
    await expect(
      ProjectDirectories.update(first.scope.id, {
        revision: first.directories.revision,
        directories: [a.path],
        mainDirectory: "/missing-directory",
      }),
    ).rejects.toThrow()
    expect((await ProjectDirectories.get(first.scope.id)).revision).toBe(first.directories.revision)
  })
})

test("busy shared folders reject the whole project edit and retain the previous selection", async () => {
  await using runtime = await testRuntime()
  await using a = await tmpdir()
  await using b = await tmpdir()
  await runtime.run(async () => {
    const created = await ProjectDirectories.create({ name: "Busy", directories: [a.path], mainDirectory: a.path })
    const record = await WorkspaceCatalog.get(created.directories.mainWorkspaceID!, created.scope.id)
    await WorkspaceAccess.task({ workspace: WorkspaceCatalog.projection(record)! }, async () => {
      await expect(
        ProjectDirectories.update(created.scope.id, {
          revision: created.directories.revision,
          directories: [a.path, b.path],
          mainDirectory: a.path,
        }),
      ).rejects.toThrow("busy")
    })
    expect((await ProjectDirectories.get(created.scope.id)).folders).toHaveLength(1)
  })
})

test("legacy folders migrate with real shared access while Git worktrees retain their original source", async () => {
  const { $ } = await import("bun")
  await using runtime = await testRuntime()
  await using a = await tmpdir({ git: true })
  await using b = await tmpdir()
  await using history = await tmpdir()
  const checkout = `${history.path}/old-task`
  await $`git worktree add -b old-task ${checkout}`.cwd(a.path).quiet()
  await runtime.run(async () => {
    const scope = await a.scope()
    await Scope.updatePersisted({ scopeID: scope.id, sandboxes: [b.path, checkout] })
    const migrated = await ProjectDirectories.get(scope.id)
    expect(migrated.folders.map((folder) => folder.path)).toEqual([a.path, b.path])
    const main = await WorkspaceCatalog.get(migrated.mainWorkspaceID!, scope.id)
    expect(await WorkspaceBinding.writableRoots(WorkspaceCatalog.projection(main)!)).toEqual([a.path, b.path])
    const tree = (await WorkspaceCatalog.list(scope.id)).find((record) => record.binding.path === checkout)
    expect(tree?.type).toBe("git_worktree")
    expect(tree?.metadata.originalCheckout).toBe(a.path)
    expect(tree?.metadata.sourceWorkspaceID).toBe(main.id)
    expect(await WorkspaceBinding.writableRoots(WorkspaceCatalog.projection(tree!)!)).toEqual([checkout, b.path])
    expect(await ProjectDirectories.get(scope.id)).toEqual(migrated)
  })
})

test("changing the main folder preserves existing tasks and old Worktrees while new tasks use the new main", async () => {
  const { ScopeContext } = await import("@ericsanchezok/synergy-harness/scope/context")
  const { Session } = await import("@ericsanchezok/synergy-harness/session")
  const { Worktree } = await import("@ericsanchezok/synergy-local-runtime/workspace/worktree")
  await using runtime = await testRuntime()
  await using a = await tmpdir({ git: true })
  await using b = await tmpdir({ git: true })
  await runtime.run(async () => {
    const project = await ProjectDirectories.create({
      name: "Multiple repositories",
      directories: [a.path, b.path],
      mainDirectory: a.path,
    })
    await ScopeContext.provide({
      scope: project.scope,
      workspace: null,
      fn: async () => {
        const oldTask = await Session.create({
          workspace: WorkspaceCatalog.projection(
            await WorkspaceCatalog.get(project.directories.mainWorkspaceID!, project.scope.id),
          ),
        })
        const treeA = await Worktree.create({
          name: "a-task",
          sourceWorkspaceID: project.directories.mainWorkspaceID!,
          bind: false,
          baseRef: "current",
        })
        const changed = await ProjectDirectories.update(project.scope.id, {
          directories: [a.path, b.path],
          mainDirectory: b.path,
          revision: project.directories.revision,
        })
        const newTask = await Session.create({
          workspace: WorkspaceCatalog.projection(
            await WorkspaceCatalog.get(changed.mainWorkspaceID!, project.scope.id),
          ),
        })
        const treeB = await Worktree.create({
          name: "b-task",
          sourceWorkspaceID: changed.mainWorkspaceID!,
          bind: false,
          baseRef: "current",
        })
        expect((await Session.get(oldTask.id)).workspace?.path).toBe(a.path)
        expect(newTask.workspace?.path).toBe(b.path)
        expect((await Worktree.resolve(treeA.id)).sourceDirectory).toBe(a.path)
        expect((await Worktree.resolve(treeB.id)).sourceDirectory).toBe(b.path)
        const records = await WorkspaceCatalog.list(project.scope.id)
        const bindingA = records.find((record) => record.binding.path === treeA.path)!
        const bindingB = records.find((record) => record.binding.path === treeB.path)!
        expect(await WorkspaceBinding.writableRoots(WorkspaceCatalog.projection(bindingA)!)).toEqual([
          treeA.path,
          b.path,
        ])
        expect(await WorkspaceBinding.writableRoots(WorkspaceCatalog.projection(bindingB)!)).toEqual([
          treeB.path,
          a.path,
        ])
        const { rename } = await import("node:fs/promises")
        const { ProjectWorktrees } = await import("../../src/project/worktrees")
        await rename(`${a.path}/.git`, `${a.path}/.git-offline`)
        try {
          const listed = await ProjectWorktrees.list(project.scope.id)
          expect(listed.find((tree) => tree.id === treeA.id)?.stale).toBe(true)
          expect(listed.find((tree) => tree.id === treeB.id)?.stale).not.toBe(true)
          await expect(Worktree.resolve(treeA.id)).rejects.toThrow()
        } finally {
          await rename(`${a.path}/.git-offline`, `${a.path}/.git`)
        }
        await Worktree.remove({ target: treeA.id, force: true })
        expect((await Worktree.resolve(treeB.id)).path).toBe(treeB.path)
        await Worktree.remove({ target: treeB.id, force: true })
      },
    })
  })
})

test("new product projects start in their main folder even when the global preference is Worktree", async () => {
  const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
  const { ScopeContext } = await import("@ericsanchezok/synergy-harness/scope/context")
  const { ProjectTaskDefaults } = await import("../../src/project/task-defaults")
  await using runtime = await testRuntime()
  await using directory = await tmpdir({ git: true })
  await runtime.run(async () => {
    await Config.domainUpdate("general", { defaultSessionWorkspace: "worktree" })
    const project = await ProjectDirectories.create({
      name: "Main by default",
      directories: [directory.path],
      mainDirectory: directory.path,
    })
    await ScopeContext.provide({
      scope: project.scope,
      fn: async () => {
        expect((await ProjectTaskDefaults.get()).effective.defaultSessionWorkspace).toBe("main")
        expect((await Config.globalResolved()).defaultSessionWorkspace).toBe("worktree")
      },
    })
  })
})
