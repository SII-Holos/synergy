import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("registered Channel upgrade converges legacy checkouts with canonical Workspace identity", () =>
  runtime.run(async () => {
    await using directory = await tmpdir()
    const scope = await directory.scope()
    const workspace = await WorkspaceBinding.register(scope.id, directory.path)
    const account = crypto.randomUUID()
    const key = StoragePath.githubChannelWorkspaceIndexEntry(account, "legacy")
    const legacy = { directory: directory.path, scopeID: scope.id, futureField: { preserved: true }, updatedAt: 42 }
    await Storage.write(key, legacy)
    const missing = StoragePath.githubChannelWorkspaceIndexEntry(account, "missing")
    await Storage.write(missing, { ...legacy, directory: path.join(directory.path, "missing") })
    const imported = StoragePath.githubChannelWorkspaceIndexEntry(account, "imported")
    await Storage.write(imported, { ...legacy, workspaceID: "wsp_historical_missing" })
    const migration = MigrationRegistry.list()
      .get("channel")
      ?.find((entry) => entry.id === "20260923-github-channel-workspace-reference")
    expect(migration).toBeDefined()
    expect(migration!.scope).toBe("global")
    await migration!.up(() => {})
    expect(await Storage.read<Record<string, unknown>>(key)).toEqual({ ...legacy, workspaceID: workspace.id })
    const absent = await Storage.read<{ workspaceID: string }>(missing)
    expect((await WorkspaceCatalog.get(absent.workspaceID, scope.id)).binding.path).toBe(
      path.join(directory.path, "missing"),
    )
    await expect(WorkspaceBinding.validate(absent.workspaceID, scope.id)).rejects.toThrow()
    expect(await Storage.read<Record<string, unknown>>(imported)).toEqual({
      ...legacy,
      workspaceID: "wsp_historical_missing",
    })
    const before = await WorkspaceCatalog.list(scope.id)
    await migration!.up(() => {})
    expect(await WorkspaceCatalog.list(scope.id)).toEqual(before)
  }))
