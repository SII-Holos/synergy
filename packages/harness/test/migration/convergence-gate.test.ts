import { expect, test } from "bun:test"
import { migrationFixture } from "./fixture"
import { MigrationRegistry } from "../../src/migration/registry"
import { completeDeferredMigrations, runMigrations, getMigrationStatus } from "../../src/migration"
import { SessionCompat } from "../../src/session/compat-import"
import { StorageCompat } from "../../src/storage/compat"
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

test("readable history requires migration settlement before an idle rerun", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const domain = "test-convergence-settlement"
    const sessionID = "ses_00000000000000000000000001"
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let executions = 0
    MigrationRegistry.register(domain, [
      {
        id: "settle",
        description: "Finish a published historical owner",
        execution: "after-convergence",
        async up() {
          executions++
          entered.resolve()
          await release.promise
        },
      },
    ])
    await StorageCompat.writeLocator(Storage.current().store, { sessionID, scopeID: "home", status: "imported" })
    const converging = completeDeferredMigrations()
    void converging.catch(entered.reject)
    try {
      await entered.promise
      expect((await SessionCompat.preparation(sessionID)).state).toBe("ready")
      expect((await getMigrationStatus(domain))[domain].pending.map((value) => value.id)).toEqual(["settle"])
      const settlement = completeDeferredMigrations()
      release.resolve()
      await settlement
      const summary = await runMigrations({
        targetDomain: domain,
        output: "silent",
      })
      expect(summary).toMatchObject({ completed: 0, failed: 0 })
      expect(executions).toBe(1)
      expect((await getMigrationStatus(domain))[domain].pending).toEqual([])
    } finally {
      release.resolve()
      await converging
    }
  })
})
