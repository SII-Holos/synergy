import { expect, test } from "bun:test"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { workspaceMigrations } from "../../src/workspace/migration"
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
