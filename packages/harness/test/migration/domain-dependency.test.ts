import { expect, test } from "bun:test"
import { MigrationRegistry } from "../../src/migration/registry"
import { runMigrations } from "../../src/migration"
import { Storage } from "../../src/storage/storage"

test("a selected domain cannot skip an unfinished dependency in another domain", async () => {
  const first = "test-dependency-owner"
  const second = "test-dependent-owner"
  let ran = false
  MigrationRegistry.register(first, [{ id: "first", description: "first", execution: "startup", async up() {} }])
  MigrationRegistry.register(second, [
    {
      id: "second",
      description: "second",
      execution: "startup",
      dependsOn: [`${first}/first`],
      async up() {
        ran = true
      },
    },
  ])
  try {
    await expect(runMigrations({ targetDomain: second, output: "silent" })).rejects.toThrow("unfinished dependency")
    expect(ran).toBe(false)
    await runMigrations({ targetDomain: first, output: "silent" })
    await runMigrations({ targetDomain: second, output: "silent" })
    expect(ran).toBe(true)
  } finally {
    MigrationRegistry.unregister(first)
    MigrationRegistry.unregister(second)
    await Storage.remove(["meta", "migration", `log-${first}`])
    await Storage.remove(["meta", "migration", `log-${second}`])
  }
})
