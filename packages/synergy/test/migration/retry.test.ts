import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { unlinkSync } from "node:fs"
import path from "node:path"
import { ensureMigrations, resetMigrations } from "../../src/migration"
import { MigrationRegistry } from "../../src/migration/registry"

const TEST_DOMAIN = "test-migration-retry"
const trackingPath = path.join(
  process.env["SYNERGY_TEST_HOME"]!,
  ".synergy",
  "data",
  "meta",
  "migration",
  `log-${TEST_DOMAIN}.json`,
)

describe("ensureMigrations failure recovery", () => {
  const reset = () => {
    try {
      unlinkSync(trackingPath)
    } catch {}
    MigrationRegistry.list().delete(TEST_DOMAIN)
    resetMigrations()
  }

  beforeEach(reset)
  afterEach(reset)

  test("retries a failed migration in the same process", async () => {
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
  })
})
