import { expect, test } from "bun:test"
import { migrationFixture } from "./fixture"
import { MigrationRegistry } from "../../src/migration/registry"
import { runMigrations, getMigrationStatus } from "../../src/migration"
import { Storage } from "../../src/storage/storage"

test("each convergence migration observes the preceding migration's durable import state", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const domain = "test-convergence-gate"
    const key = ["compat_import", "info"]
    let first = 0
    let second = 0
    MigrationRegistry.register(domain, [
      {
        id: "first",
        description: "Quarantine a discovered import",
        execution: "after-convergence",
        async up() {
          first++
          await Storage.write(key, { counts: { pending: 0, partial: 0, quarantined: 1, imported: 0, total: 1 } })
        },
      },
      {
        id: "second",
        description: "Require completed import",
        execution: "after-convergence",
        dependsOn: ["first"],
        async up() {
          second++
        },
      },
    ])
    const initial = await runMigrations({ targetDomain: domain, output: "silent" })
    expect(initial.completed).toBe(1)
    expect(initial.deferred).toBe(1)
    expect(second).toBe(0)
    expect((await getMigrationStatus(domain))[domain].pending.map((value) => value.id)).toEqual(["second"])
    await Storage.write(key, { counts: { pending: 0, partial: 0, quarantined: 0, imported: 1, total: 1 } })
    const resumed = await runMigrations({ targetDomain: domain, output: "silent" })
    expect(resumed.completed).toBe(1)
    expect(first).toBe(1)
    expect(second).toBe(1)
    expect((await getMigrationStatus(domain))[domain].pending).toEqual([])
  })
})
