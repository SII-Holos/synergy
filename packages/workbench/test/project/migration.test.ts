import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { getMigrationStatus, runMigrations } from "@ericsanchezok/synergy-harness/migration"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { WorkspaceBinding, WorkspaceCatalog, WorkspaceLocation } from "@ericsanchezok/synergy-harness/workspace"
import { migrationFixture } from "@ericsanchezok/synergy-harness/test/migration/fixture"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { createLocalHost } from "@ericsanchezok/synergy-local-runtime/host"
import { ProjectDirectories } from "../../src/project/directories"
import { registerProjectMigrations } from "../../src/project/migration"

const register = () => {
  registerLocalRuntime()
  registerProjectMigrations()
}

test("project migration completes on a fresh home", async () => {
  await using runtime = await migrationFixture({ register })
  await runtime.run(async () => {
    expect(await runMigrations({ output: "silent", targetDomain: "workbench-projects" })).toMatchObject({
      completed: 1,
      failed: 0,
    })
    expect((await getMigrationStatus("workbench-projects"))["workbench-projects"].pending).toHaveLength(0)
  })
})

test("project migration retains missing folders and historical Worktrees across restart", async () => {
  await using home = await tmpdir()
  await using main = await tmpdir({ git: true })
  await using additional = await tmpdir()
  const checkout = path.join(main.path, "old-task")
  const { $ } = await import("bun")
  await $`git worktree add -b old-task ${checkout}`.cwd(main.path).quiet()
  await using runtime = await migrationFixture({ home: home.path, register })
  const fixture = await runtime.run(async () => {
    const scope = await main.scope()
    await Scope.updatePersisted({ scopeID: scope.id, sandboxes: [additional.path, checkout] })
    const source = WorkspaceLocation.source()
    const tree = await WorkspaceCatalog.register({
      scopeID: scope.id,
      type: "git_worktree",
      hostID: await source.hostID(),
      ...(await source.identify(checkout)),
      metadata: { originalCheckout: main.path, worktreeID: "wt_historical", name: "old-task" },
    })
    return { scope: await Scope.fromID(scope.id), tree }
  })
  await runtime.close()
  await fs.rm(main.path, { recursive: true })

  await using upgraded = await migrationFixture({ home: home.path, register })
  const migrated = await upgraded.run(async () => {
    expect(await runMigrations({ output: "silent", targetDomain: "workbench-projects" })).toMatchObject({
      completed: 1,
      failed: 0,
    })
    const scopeID = fixture.scope!.id
    expect(await Scope.fromID(scopeID)).toEqual(fixture.scope)
    const result = await ProjectDirectories.get(scopeID)
    expect(result.folders.map(({ path, available }) => ({ path, available }))).toEqual([
      { path: main.path, available: false },
      { path: additional.path, available: true },
    ])
    expect(result.mainWorkspaceID).toBe(result.folders[0]!.workspaceID)
    const tree = await WorkspaceCatalog.get(fixture.tree.id, scopeID)
    expect(tree.binding).toEqual(fixture.tree.binding)
    expect(tree.metadata).toEqual(fixture.tree.metadata)
    await expect(WorkspaceBinding.validate(tree.id, scopeID)).rejects.toThrow()
    expect((await getMigrationStatus("workbench-projects"))["workbench-projects"].pending).toHaveLength(0)
    return result
  })
  await upgraded.close()

  await using restarted = await migrationFixture({ home: home.path, register })
  await restarted.run(async () => {
    expect(await runMigrations({ output: "silent", targetDomain: "workbench-projects" })).toMatchObject({
      completed: 0,
      failed: 0,
    })
    expect(await ProjectDirectories.get(fixture.scope!.id)).toEqual(migrated)
  })
})

test("project migration retains a path replaced by a file without granting directory access", async () => {
  await using runtime = await migrationFixture({ register })
  await using directory = await tmpdir()
  const project = path.join(directory.path, "project")
  await fs.mkdir(project)
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(project)
    await fs.rm(project, { recursive: true })
    await Bun.write(project, "replacement file")
    expect(await runMigrations({ output: "silent", targetDomain: "workbench-projects" })).toMatchObject({
      completed: 1,
      failed: 0,
    })
    expect((await getMigrationStatus("workbench-projects"))["workbench-projects"].pending).toHaveLength(0)
    const result = await ProjectDirectories.get(scope.id)
    expect(result.folders).toHaveLength(1)
    expect(result.folders[0]).toMatchObject({ path: project, available: false })
    await expect(WorkspaceBinding.validate(result.mainWorkspaceID!, scope.id)).rejects.toMatchObject({
      name: "WorkspaceUnavailable",
    })
    expect(await Scope.fromID(scope.id)).toEqual(scope)
    expect(await Bun.file(project).text()).toBe("replacement file")
  })
})

test("project migration canonicalizes folder aliases before separating historical Worktrees", async () => {
  await using runtime = await migrationFixture({ register })
  const source = createLocalHost({ home: runtime.host.home }).workspaceLocation!
  runtime.host.workspaceLocation!.identify = source.identify
  const home = await fs.realpath(runtime.host.home)
  const main = path.join(home, "project")
  const additional = path.join(home, "additional")
  const tree = path.join(home, "historical-tree")
  for (const directory of [main, additional, tree]) {
    await fs.mkdir(directory)
    await fs.symlink(directory, `${directory}-alias`, "junction")
  }
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(main)
    await Scope.updatePersisted({
      scopeID: scope.id,
      sandboxes: [`${main}-alias`, additional, `${additional}-alias`, `${tree}-alias`],
    })
    const original = await WorkspaceCatalog.register({
      scopeID: scope.id,
      hostID: await WorkspaceLocation.source().hostID(),
      type: "git_worktree",
      ...(await source.identify(tree)),
      metadata: { originalCheckout: main },
    })
    expect(await runMigrations({ output: "silent", targetDomain: "workbench-projects" })).toMatchObject({
      completed: 1,
      failed: 0,
    })
    const result = await ProjectDirectories.get(scope.id)
    expect(result.folders.map((folder) => folder.path)).toEqual([main, additional])
    const retained = await WorkspaceCatalog.get(original.id, scope.id)
    expect(retained.binding).toEqual(original.binding)
    expect(retained.metadata).toEqual(original.metadata)
    expect(retained.sharedWritableWorkspaceIDs).toEqual(result.additionalWorkspaceIDs)
    expect(await WorkspaceCatalog.list(scope.id)).toHaveLength(3)
  })
})

test("project migration keeps unexpected identity errors pending and retries without partial conversion", async () => {
  await using runtime = await migrationFixture({ register })
  await using directory = await tmpdir()
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(directory.path)
    const source = runtime.host.workspaceLocation!
    const identify = source.identify
    source.identify = async () => {
      throw Object.assign(new Error("identity provider unavailable"), { code: "EIO" })
    }
    await expect(runMigrations({ output: "silent", targetDomain: "workbench-projects" })).rejects.toThrow(
      "identity provider unavailable",
    )
    expect(await Storage.readMany([StoragePath.projectDirectories(scope.id)])).toEqual([undefined])
    expect((await getMigrationStatus("workbench-projects"))["workbench-projects"].pending).toHaveLength(1)
    source.identify = identify
    expect(await runMigrations({ output: "silent", targetDomain: "workbench-projects" })).toMatchObject({
      completed: 1,
      failed: 0,
    })
    expect((await ProjectDirectories.get(scope.id)).folders).toHaveLength(1)
  })
})

test.each(["legacy", "old-mount", "replacement", "missing", "file", "symlink-loop"] as const)(
  "central startup preserves %s Workspace references through project and identity migration",
  async (scenario) => {
    await using runtime = await migrationFixture({ register })
    const source = createLocalHost({ home: runtime.host.home }).workspaceLocation!
    runtime.host.workspaceLocation!.identify = source.identify
    const home = await fs.realpath(runtime.host.home)
    const directory = path.join(home, "project")
    const treeDirectory = path.join(home, "historical-tree")
    const additional = path.join(home, "additional")
    for (const location of [directory, treeDirectory, additional]) await fs.mkdir(location)
    await runtime.run(async () => {
      const { scope } = await Scope.fromDirectory(directory)
      await Scope.updatePersisted({ scopeID: scope.id, sandboxes: [additional, treeDirectory] })
      const hostID = await WorkspaceLocation.source().hostID()
      const original = []
      for (const location of [directory, treeDirectory]) {
        const identity = await source.identify(location)
        const legacy = identity.legacyPhysicalID ?? identity.physicalID!
        const oldMount = legacy.split(":")
        const device = legacy.startsWith("overlay:") ? 1 : 0
        oldMount[device] = String(BigInt(oldMount[device]!) + 2n)
        original.push(
          await WorkspaceCatalog.register({
            scopeID: scope.id,
            hostID,
            type: location === directory ? "main" : "git_worktree",
            path: identity.path,
            physicalID: scenario === "old-mount" ? oldMount.join(":") : legacy,
            metadata: location === directory ? { retained: true } : { originalCheckout: directory, retained: true },
          }),
        )
        if (scenario === "replacement") {
          await fs.rename(location, `${location}-old`)
          await fs.mkdir(location)
        }
        if (["missing", "file", "symlink-loop"].includes(scenario)) await fs.rm(location, { recursive: true })
        if (scenario === "file") await Bun.write(location, "retained replacement file")
        if (scenario === "symlink-loop") await fs.symlink(location, location, "junction")
      }
      for (const [domain, migrations] of MigrationRegistry.list())
        await Storage.write(
          StoragePath.metaMigrationLogDomain(domain),
          Object.fromEntries(
            migrations
              .filter(
                (migration) =>
                  !["20261003-persistent-volume-identity", "20260929-project-directories"].includes(migration.id),
              )
              .map((migration) => [migration.id, 1]),
          ),
        )
      expect(await runMigrations({ output: "silent" })).toMatchObject({ failed: 0, completed: 2 })
      const result = await ProjectDirectories.get(scope.id)
      expect(result.mainWorkspaceID).toBe(original[0]!.id)
      expect(result.folders.map((folder) => [folder.path, folder.available])).toEqual([
        [directory, scenario === "legacy"],
        [additional, true],
      ])
      for (const previous of original) {
        const retained = await WorkspaceCatalog.get(previous.id, scope.id)
        expect(retained.metadata).toEqual(previous.metadata)
        expect(retained.binding.generation).toBe(previous.binding.generation)
        if (scenario !== "legacy") {
          expect(retained.binding).toEqual(previous.binding)
          await expect(WorkspaceBinding.validate(previous.id, scope.id)).rejects.toMatchObject({
            name: "WorkspaceUnavailable",
          })
        }
      }
      expect(await runMigrations({ output: "silent" })).toMatchObject({ failed: 0, completed: 0 })
      expect(await ProjectDirectories.get(scope.id)).toEqual(result)
    })
  },
)

test.each(["foreign", "unbound", "deleted"] as const)(
  "project migration preserves retired and %s Worktrees without creating local authority",
  async (state) => {
    await using runtime = await migrationFixture({ register })
    const home = await fs.realpath(runtime.host.home)
    const main = path.join(home, "main")
    const foreign = path.join(home, "foreign-tree")
    await fs.mkdir(main)
    await fs.mkdir(foreign)
    await runtime.run(async () => {
      const { scope } = await Scope.fromDirectory(main)
      const source = WorkspaceLocation.source()
      const local = await WorkspaceCatalog.register({
        scopeID: scope.id,
        hostID: await source.hostID(),
        type: "directory",
        ...(await source.identify(main)),
      })
      const [retired] = await WorkspaceCatalog.beginRetirement([local])
      const remote = await WorkspaceCatalog.register({
        scopeID: scope.id,
        hostID: "another-host",
        type: "git_worktree",
        path: foreign,
        physicalID: "foreign-identity",
        metadata: { originalCheckout: main, retained: true },
      })
      const retained =
        state === "unbound"
          ? await WorkspaceCatalog.importRecord({ ...remote, id: "wsp_imported_tree" })
          : state === "deleted"
            ? (
                await WorkspaceCatalog.completeRetirement(await WorkspaceCatalog.beginRetirement([remote]), "deleted")
              )[0]
            : remote
      expect(await runMigrations({ output: "silent", targetDomain: "workbench-projects" })).toMatchObject({
        completed: 1,
        failed: 0,
      })
      expect(await WorkspaceCatalog.list(scope.id)).toHaveLength(state === "unbound" ? 3 : 2)
      expect(await WorkspaceCatalog.get(retired.id, scope.id)).toEqual(retired)
      expect(await WorkspaceCatalog.get(retained.id, scope.id)).toEqual(retained)
      const result = await ProjectDirectories.get(scope.id)
      expect(result.mainWorkspaceID).toBe(local.id)
      expect(result.folders).toHaveLength(1)
      expect(result.folders[0].available).toBe(false)
      for (const record of [retired, retained])
        await expect(WorkspaceBinding.validate(record.id, scope.id)).rejects.toMatchObject({
          name: "WorkspaceUnavailable",
        })
    })
  },
)

test("project migration resumes a partially converted catalog without changing completed bindings", async () => {
  await using runtime = await migrationFixture({ register })
  await using first = await tmpdir()
  await using second = await tmpdir()
  await runtime.run(async () => {
    await Scope.fromDirectory(first.path)
    await Scope.fromDirectory(second.path)
    const [completed, pending] = await Scope.list()
    const source = WorkspaceLocation.source()
    const identify = source.identify
    source.identify = async (directory, allowMissing) => {
      if (directory === pending.local!.worktree)
        throw Object.assign(new Error("temporary provider failure"), { code: "EIO" })
      return identify(directory, allowMissing)
    }
    await expect(runMigrations({ output: "silent", targetDomain: "workbench-projects" })).rejects.toThrow(
      "temporary provider failure",
    )
    const previous = await Storage.read<ProjectDirectories.Record>(StoragePath.projectDirectories(completed.id))
    expect(previous).toMatchObject({ version: 1, scopeID: completed.id })
    expect(await Storage.readMany([StoragePath.projectDirectories(pending.id)])).toEqual([undefined])
    const bindings = await WorkspaceCatalog.list(completed.id)
    expect((await getMigrationStatus("workbench-projects"))["workbench-projects"].pending).toHaveLength(1)
    source.identify = identify
    expect(await runMigrations({ output: "silent", targetDomain: "workbench-projects" })).toMatchObject({
      completed: 1,
      failed: 0,
    })
    expect(await Storage.read<ProjectDirectories.Record>(StoragePath.projectDirectories(completed.id))).toEqual(
      previous,
    )
    expect(await WorkspaceCatalog.list(completed.id)).toEqual(bindings)
    expect((await ProjectDirectories.get(pending.id)).folders).toHaveLength(1)
  })
})

test("a project rooted at a retained Worktree keeps its main identity and shares additional folders once", async () => {
  await using runtime = await migrationFixture({ register })
  await using main = await tmpdir()
  await using additional = await tmpdir()
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(main.path)
    await Scope.updatePersisted({ scopeID: scope.id, sandboxes: [additional.path] })
    const source = WorkspaceLocation.source()
    const record = await WorkspaceCatalog.register({
      scopeID: scope.id,
      hostID: await source.hostID(),
      type: "git_worktree",
      ...(await source.identify(main.path)),
      metadata: { originalCheckout: path.join(main.path, "previous-checkout") },
    })
    await runMigrations({ output: "silent", targetDomain: "workbench-projects" })
    const result = await ProjectDirectories.get(scope.id)
    expect(result.mainWorkspaceID).toBe(record.id)
    expect(result.folders.map((folder) => folder.path)).toEqual([main.path, additional.path])
    const migrated = await WorkspaceCatalog.get(record.id, scope.id)
    expect(migrated.binding).toEqual(record.binding)
    expect(migrated.metadata).toEqual(record.metadata)
    expect(migrated.sharedWritableWorkspaceIDs).toEqual(result.additionalWorkspaceIDs)
    expect(migrated.revision).toBe(record.revision + 1)
  })
})

test("project sharing migration retains active grants while removing retired grants", async () => {
  await using runtime = await migrationFixture({ register })
  await using main = await tmpdir()
  await using additional = await tmpdir()
  await using old = await tmpdir()
  await using active = await tmpdir()
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(main.path)
    await Scope.updatePersisted({ scopeID: scope.id, sandboxes: [additional.path] })
    const source = WorkspaceLocation.source()
    const records = await Promise.all(
      [main.path, old.path, active.path].map(async (directory) =>
        WorkspaceCatalog.register({
          scopeID: scope.id,
          hostID: await source.hostID(),
          type: "directory",
          ...(await source.identify(directory)),
        }),
      ),
    )
    await WorkspaceCatalog.setSharing(records[0].id, {
      scopeID: scope.id,
      expectedRevision: records[0].revision,
      workspaceIDs: records.slice(1).map((record) => record.id),
    })
    const [retired] = await WorkspaceCatalog.beginRetirement([records[1]])
    await runMigrations({ output: "silent", targetDomain: "workbench-projects" })
    const result = await ProjectDirectories.get(scope.id)
    const migrated = await WorkspaceCatalog.get(records[0].id, scope.id)
    expect(migrated.sharedWritableWorkspaceIDs).toEqual([records[2].id, ...result.additionalWorkspaceIDs])
    expect(await WorkspaceCatalog.get(retired.id, scope.id)).toEqual(retired)
    expect(migrated.binding).toEqual(records[0].binding)
  })
})

test.each(["foreign", "unbound"] as const)(
  "a retained %s Worktree used as the project main does not gain local authority",
  async (state) => {
    await using runtime = await migrationFixture({ register })
    await using main = await tmpdir()
    await runtime.run(async () => {
      const { scope } = await Scope.fromDirectory(main.path)
      const record =
        state === "unbound"
          ? await WorkspaceCatalog.get(
              (
                await WorkspaceBinding.importHistory(
                  { scopeID: scope.id, type: "git_worktree", path: main.path },
                  scope.id,
                )
              ).id!,
              scope.id,
            )
          : await WorkspaceCatalog.register({
              scopeID: scope.id,
              hostID: "another-host",
              type: "git_worktree",
              path: main.path,
              physicalID: "foreign-identity",
            })
      await runMigrations({ output: "silent", targetDomain: "workbench-projects" })
      const result = await ProjectDirectories.get(scope.id)
      const mainRecord = await WorkspaceCatalog.get(result.mainWorkspaceID!, scope.id)
      expect(mainRecord.id).toBe(record.id)
      expect(result.folders[0].available).toBe(false)
      expect(mainRecord.binding.hostID).toBe(record.binding.hostID)
      expect(await WorkspaceCatalog.get(record.id, scope.id)).toEqual(record)
      await expect(WorkspaceBinding.validate(mainRecord.id, scope.id)).rejects.toMatchObject({
        name: "WorkspaceUnavailable",
      })
      expect(await WorkspaceCatalog.list(scope.id)).toHaveLength(1)
    })
  },
)
