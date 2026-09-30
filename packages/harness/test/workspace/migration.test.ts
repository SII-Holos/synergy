import { expect, test } from "bun:test"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { workspaceMigrations } from "../../src/workspace/migration"
import { WorkspaceCheckpoints } from "../../src/workspace/checkpoint"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { testRuntime } from "../support/runtime"

test("workspace storage migration is idempotent and preserves local identity, generation and history", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await workspaceMigrations[0].up(() => {})
    const original = await WorkspaceCatalog.register({
      scopeID: "scope",
      type: "git_worktree",
      hostID: "host",
      path: "/directory",
      physicalID: "device:inode",
      metadata: { branch: "work" },
    })
    const { backend: _backend, content: _content, ...legacy } = original
    await Storage.write(StoragePath.workspace(original.id), legacy)
    await workspaceMigrations[0].up(() => {})
    const migrated = await WorkspaceCatalog.get(original.id, "scope")
    expect(migrated).toEqual(original)
    await workspaceMigrations[0].up(() => {})
    expect(await WorkspaceCatalog.get(original.id, "scope")).toEqual(migrated)
    expect(await Storage.list(["environment"])).toHaveLength(0)
  })
})

test("checkpoint migration preserves legacy effects and requires a fresh, version-fenced capture", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const migration = workspaceMigrations.find((item) => item.id === "20260929-workspace-checkpoint-attempts")!
    await migration.up(() => {})
    const workspace = await WorkspaceCatalog.create({
      scopeID: "scope",
      backend: { provider: "objects", spec: { blobStore: "fixture" } },
    })
    const mount = { id: "mount", workspaceID: workspace.id, generation: 1 }
    const target = { environmentID: "environment", allocationID: "allocation", generation: 1 }
    await Storage.write(StoragePath.workspaceOperation("scope", "legacy"), {
      id: "legacy",
      scopeID: "scope",
      workspaceID: workspace.id,
      generation: 1,
      target,
      input: { id: "legacy", mount, path: "file", data: "eA==", expectedVersion: null },
      digest: "unchanged",
      state: "unsaved",
      createdAt: 1,
      updatedAt: 1,
    })
    await Storage.write(StoragePath.workspaceOperationActive("scope", "legacy"), true)
    const original = await Storage.read<Record<string, unknown>>(StoragePath.workspaceOperation("scope", "legacy"))
    await migration.up(() => {})
    await migration.up(() => {})
    const attempt = await WorkspaceCheckpoints.begin(workspace, "legacy")
    expect(attempt.id).not.toBe("legacy")
    expect(attempt.workspace.content).toEqual(workspace.content)
    expect(
      (await WorkspaceCheckpoints.begin({ ...workspace, content: { revision: 9, manifest: null } }, "legacy")).id,
    ).toBe(attempt.id)
    expect(
      (await WorkspaceCheckpoints.begin({ ...workspace, content: { revision: 9, manifest: null } }, "legacy")).workspace
        .content,
    ).toEqual(workspace.content)
    expect(await Storage.read<Record<string, unknown>>(StoragePath.workspaceOperation("scope", "legacy"))).toEqual(
      original,
    )
    await WorkspaceCheckpoints.conflict(attempt)
    const next = await WorkspaceCheckpoints.begin({ ...workspace, content: { revision: 9, manifest: null } }, "legacy")
    expect(next.id).not.toBe(attempt.id)
    expect(next.workspace.content?.revision).toBe(9)
    expect((await Storage.read<{ attempts: unknown[] }>(attempt.key)).attempts).toHaveLength(3)
  })
})
