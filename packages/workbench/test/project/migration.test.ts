import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { getMigrationStatus, runMigrations } from "@ericsanchezok/synergy-harness/migration"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { WorkspaceBinding, WorkspaceCatalog, WorkspaceLocation } from "@ericsanchezok/synergy-harness/workspace"
import { migrationFixture } from "@ericsanchezok/synergy-harness/test/migration/fixture"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
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

test("project migration keeps invalid directory identities fatal and leaves the migration pending", async () => {
  await using runtime = await migrationFixture({ register })
  await using directory = await tmpdir()
  const project = path.join(directory.path, "project")
  await fs.mkdir(project)
  await runtime.run(async () => {
    const { scope } = await Scope.fromDirectory(project)
    await fs.rm(project, { recursive: true })
    await Bun.write(project, "replacement file")
    await expect(runMigrations({ output: "silent", targetDomain: "workbench-projects" })).rejects.toMatchObject({
      code: "ENOTDIR",
    })
    expect((await getMigrationStatus("workbench-projects"))["workbench-projects"].pending).toHaveLength(1)
    expect(await Scope.fromID(scope.id)).toEqual(scope)
    expect(await Bun.file(project).text()).toBe("replacement file")
  })
})
