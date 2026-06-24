import { describe, expect, test, afterEach } from "bun:test"
import { existsSync, readFileSync, unlinkSync } from "node:fs"
import path from "node:path"
import { MigrationRegistry } from "../../src/migration/registry"
import { resetMigrations, runMigrations } from "../../src/migration"
import type { Migration } from "../../src/migration/types"

// Use the preload's test home directory
const dataDir = path.join(process.env["SYNERGY_TEST_HOME"]!, ".synergy", "data")
const TEST_DOMAIN = "test-dry-run"

function trackingPath(domain: string): string {
  return path.join(dataDir, "meta", "migration", `log-${domain}.json`)
}

describe("runMigrations dry run", () => {
  afterEach(() => {
    // Clean migration tracking and reset state
    const p = trackingPath(TEST_DOMAIN)
    try {
      unlinkSync(p)
    } catch {}
    MigrationRegistry.list().delete(TEST_DOMAIN)
    resetMigrations()
  })

  test("dryRun: reports pending migrations but does not execute up()", async () => {
    let upWasCalled = false

    const testMigration: Migration = {
      id: "20260601-test-dry-run",
      description: "Test dry-run migration (should not execute)",
      async up(_progress) {
        upWasCalled = true
      },
    }

    MigrationRegistry.register(TEST_DOMAIN, [testMigration])

    await runMigrations({ dryRun: true, targetDomain: TEST_DOMAIN })

    expect(upWasCalled).toBe(false)
  })

  test("dryRun: no tracking file is created after dry run", async () => {
    const testMigration: Migration = {
      id: "20260602-test-no-tracking",
      description: "Test dry-run no tracking",
      async up(_progress) {},
    }

    MigrationRegistry.register(TEST_DOMAIN, [testMigration])

    await runMigrations({ dryRun: true, targetDomain: TEST_DOMAIN })

    const p = trackingPath(TEST_DOMAIN)
    expect(existsSync(p)).toBe(false)
  })

  test("non-dryRun: migration executes and tracking file is created", async () => {
    let upWasCalled = false

    const testMigration: Migration = {
      id: "20260603-test-executes",
      description: "Test non-dry-run migration executes",
      async up(_progress) {
        upWasCalled = true
      },
    }

    MigrationRegistry.register(TEST_DOMAIN, [testMigration])

    const summary = await runMigrations({ dryRun: false, targetDomain: TEST_DOMAIN })

    expect(upWasCalled).toBe(true)
    expect(summary).toEqual(
      expect.objectContaining({
        totalDomains: 1,
        completed: 1,
        dryRun: 0,
        failed: 0,
      }),
    )

    const p = trackingPath(TEST_DOMAIN)
    expect(existsSync(p)).toBe(true)

    const data = JSON.parse(readFileSync(p, "utf-8"))
    expect(data).toHaveProperty("20260603-test-executes")
  })

  test("dryRun with multiple migrations reports all pending without executing", async () => {
    const calledIds: string[] = []

    const m1: Migration = {
      id: "20260604-multi-a",
      description: "Multi A",
      async up() {
        calledIds.push("a")
      },
    }
    const m2: Migration = {
      id: "20260604-multi-b",
      description: "Multi B",
      async up() {
        calledIds.push("b")
      },
    }
    const m3: Migration = {
      id: "20260604-multi-c",
      description: "Multi C",
      async up() {
        calledIds.push("c")
      },
    }

    MigrationRegistry.register(TEST_DOMAIN, [m1, m2, m3])

    await runMigrations({ dryRun: true, targetDomain: TEST_DOMAIN })

    expect(calledIds).toEqual([])

    const p = trackingPath(TEST_DOMAIN)
    expect(existsSync(p)).toBe(false)
  })

  test("silent output returns summary without writing to stderr", async () => {
    const testMigration: Migration = {
      id: "20260605-silent-summary",
      description: "Silent summary",
      async up(_progress) {},
    }
    MigrationRegistry.register(TEST_DOMAIN, [testMigration])

    const originalWrite = process.stderr.write.bind(process.stderr)
    const output: string[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stderr.write = ((chunk: any) => {
      output.push(String(chunk))
      return true
    }) as any

    try {
      const summary = await runMigrations({ output: "silent", targetDomain: TEST_DOMAIN })
      expect(summary.totalDomains).toBe(1)
      expect(summary.completed).toBe(1)
      expect(output.join("")).toBe("")
    } finally {
      process.stderr.write = originalWrite
    }
  })
})
