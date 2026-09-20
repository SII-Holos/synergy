import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { ensureMigrations, resetMigrations } from "../../src/migration"
import { MigrationRegistry } from "../../src/migration/registry"
import { afterAll as afterRuntimeTests } from "bun:test"
import { migrationFixture as testRuntime } from "./fixture"
const runtime = await testRuntime()

const TEST_DOMAIN = "test-migration-retry"
const trackingPath = ["meta", "migration", `log-${TEST_DOMAIN}`]

describe("ensureMigrations failure recovery", () => {
  const reset = async () => {
    try {
      await Storage.remove(trackingPath)
    } catch {}
    MigrationRegistry.unregister(TEST_DOMAIN)
    resetMigrations()
  }

  beforeEach(() => runtime.run(reset))
  afterEach(() => runtime.run(reset))

  test("retries a failed migration in the same process", () =>
    runtime.run(async () => {
      let attempts = 0
      MigrationRegistry.register(TEST_DOMAIN, [
        {
          id: "20260712-test-migration-retry",
          description: "Retry a transient migration failure",
          async up(progress) {
            attempts++
            if (attempts === 1) throw new Error("transient migration failure")
            progress(1, 1)
          },
        },
      ])

      await expect(ensureMigrations({ output: "silent", targetDomain: TEST_DOMAIN })).rejects.toThrow(
        "transient migration failure",
      )

      const summary = await ensureMigrations({ output: "silent", targetDomain: TEST_DOMAIN })
      expect(attempts).toBe(2)
      expect(summary.completed).toBe(1)
    }))
})

afterRuntimeTests(() => runtime.close())
