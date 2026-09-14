import { describe, expect, test, afterEach } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { MigrationRegistry } from "../../src/migration/registry"
import { resetMigrations, runMigrations } from "../../src/migration"
import type { Migration } from "../../src/migration/types"

const TEST_DOMAIN = "test-dry-run"
const trackingPath = (domain: string) => ["meta", "migration", `log-${domain}`]

describe("runMigrations dry run", () => {
  afterEach(async () => {
    await Storage.remove(trackingPath(TEST_DOMAIN))
    MigrationRegistry.unregister(TEST_DOMAIN)
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

  test("dryRun: no tracking record is created after dry run", async () => {
    const testMigration: Migration = {
      id: "20260602-test-no-tracking",
      description: "Test dry-run no tracking",
      async up(_progress) {},
    }

    MigrationRegistry.register(TEST_DOMAIN, [testMigration])

    await runMigrations({ dryRun: true, targetDomain: TEST_DOMAIN })

    const p = trackingPath(TEST_DOMAIN)
    expect((await Storage.readMany([p]))[0]).toBeUndefined()
  })

  test("non-dryRun: migration executes and tracking record is created", async () => {
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
    expect((await Storage.readMany([p]))[0]).toBeDefined()

    const data = await Storage.read(p)
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
    expect((await Storage.readMany([p]))[0]).toBeUndefined()
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
