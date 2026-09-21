import { afterAll as afterRuntimeTests } from "bun:test"
import { migrationFixture } from "./fixture"
const runtime = await migrationFixture()
import { afterEach, expect, test } from "bun:test"
import { MigrationRegistry } from "../../src/migration/registry"
import { runMigrations, resetMigrations } from "../../src/migration"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"

const domain = "test-maintenance-gate"
afterEach(() =>
  runtime.run(async () => {
    MigrationRegistry.unregister(domain)
    await Storage.remove(StoragePath.metaMigrationLogDomain(domain))
    resetMigrations()
  }),
)

test.each([false, true])("ordinary startup never executes optional work, including applied=%s", (applied) =>
  runtime.run(async () => {
    let calls = 0
    MigrationRegistry.register(domain, [
      {
        id: "maintenance",
        description: "Optional work",
        execution: "maintenance",
        isApplied: async () => applied,
        async up() {
          calls++
        },
      },
    ])
    await runMigrations({ targetDomain: domain, output: "silent" })
    expect(calls).toBe(0)
    const [ledger] = await Storage.readMany<Record<string, number>>([StoragePath.metaMigrationLogDomain(domain)])
    expect(Boolean(ledger?.maintenance)).toBe(applied)
    await runMigrations({ targetDomain: domain, output: "silent", maintenance: true })
    expect(calls).toBe(applied ? 0 : 1)
  }),
)

test("an applied maintenance probe cannot mutate the ledger during a dry run", () =>
  runtime.run(async () => {
    MigrationRegistry.register(domain, [
      {
        id: "maintenance",
        description: "Optional work",
        execution: "maintenance",
        isApplied: async () => true,
        async up() {
          throw new Error("must not execute")
        },
      },
    ])
    await runMigrations({ targetDomain: domain, output: "silent", dryRun: true })
    expect(await Storage.readMany([StoragePath.metaMigrationLogDomain(domain)])).toEqual([undefined])
  }))

afterRuntimeTests(() => runtime.close())
