import { describe, expect, test, afterEach } from "bun:test"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { MigrationRegistry } from "../../src/migration/registry"
import { rollbackMigrations, resetMigrations, runMigrations } from "../../src/migration"
import type { Migration } from "../../src/migration/types"

const dataDir = path.join(process.env["SYNERGY_TEST_HOME"]!, ".synergy", "data")
const TEST_DOMAIN = "test-rollback"

function trackingPath(domain: string): string {
  return path.join(dataDir, "meta", "migration", `log-${domain}.json`)
}

describe("rollbackMigrations", () => {
  afterEach(() => {
    const p = trackingPath(TEST_DOMAIN)
    try {
      unlinkSync(p)
    } catch {}
    MigrationRegistry.list().delete(TEST_DOMAIN)
    resetMigrations()
  })

  test("rollback to middle migration rolls back target + older", async () => {
    const called: string[] = []

    const m1: Migration = {
      id: "20260605-rb-a",
      description: "Oldest A",
      async up() {},
      async down() {
        called.push("a")
      },
    }
    const m2: Migration = {
      id: "20260605-rb-b",
      description: "Middle B",
      async up() {},
      async down() {
        called.push("b")
      },
    }
    const m3: Migration = {
      id: "20260605-rb-c",
      description: "Newest C",
      async up() {},
      async down() {
        called.push("c")
      },
    }

    MigrationRegistry.register(TEST_DOMAIN, [m1, m2, m3])

    await runMigrations({ targetDomain: TEST_DOMAIN })

    // Rollback to middle: b and a roll back, c stays
    await rollbackMigrations(TEST_DOMAIN, "20260605-rb-b")

    // down() iterates toRollback in the collected order: [b, a]
    expect(called).toEqual(["b", "a"])

    const after = JSON.parse(readFileSync(trackingPath(TEST_DOMAIN), "utf-8"))
    expect(after).not.toHaveProperty("20260605-rb-a")
    expect(after).not.toHaveProperty("20260605-rb-b")
    expect(after).toHaveProperty("20260605-rb-c")
  })

  test("rollback to oldest migration rolls back only that one", async () => {
    const called: string[] = []

    const m1: Migration = {
      id: "20260605b-rb-a",
      description: "Oldest A",
      async up() {},
      async down() {
        called.push("a")
      },
    }
    const m2: Migration = {
      id: "20260605b-rb-b",
      description: "Newer B",
      async up() {},
      async down() {
        called.push("b")
      },
    }

    MigrationRegistry.register(TEST_DOMAIN, [m1, m2])

    await runMigrations({ targetDomain: TEST_DOMAIN })

    await rollbackMigrations(TEST_DOMAIN, "20260605b-rb-a")

    expect(called).toEqual(["a"])

    const after = JSON.parse(readFileSync(trackingPath(TEST_DOMAIN), "utf-8"))
    expect(after).not.toHaveProperty("20260605b-rb-a")
    expect(after).toHaveProperty("20260605b-rb-b")
  })

  test("rollback to newest rolls back all completed migrations", async () => {
    const called: string[] = []

    const m1: Migration = {
      id: "20260606-all-a",
      description: "All A",
      async up() {},
      async down() {
        called.push("a")
      },
    }
    const m2: Migration = {
      id: "20260606-all-b",
      description: "All B",
      async up() {},
      async down() {
        called.push("b")
      },
    }
    const m3: Migration = {
      id: "20260606-all-c",
      description: "All C",
      async up() {},
      async down() {
        called.push("c")
      },
    }

    MigrationRegistry.register(TEST_DOMAIN, [m1, m2, m3])

    await runMigrations({ targetDomain: TEST_DOMAIN })

    await rollbackMigrations(TEST_DOMAIN, "20260606-all-c")

    expect(called).toEqual(["c", "b", "a"])

    const after = JSON.parse(readFileSync(trackingPath(TEST_DOMAIN), "utf-8"))
    expect(Object.keys(after)).toHaveLength(0)
  })

  test("rollback of migration without down() still removes tracking entry", async () => {
    const m1: Migration = {
      id: "20260607-nodown-a",
      description: "No down - oldest",
      async up() {},
    }
    const m2: Migration = {
      id: "20260607-withdown-b",
      description: "Has down - newer",
      async up() {},
      async down() {},
    }

    MigrationRegistry.register(TEST_DOMAIN, [m1, m2])

    await runMigrations({ targetDomain: TEST_DOMAIN })

    // Rollback to oldest: m1 (no down) is unmarked, m2 stays
    await rollbackMigrations(TEST_DOMAIN, "20260607-nodown-a")

    const after = JSON.parse(readFileSync(trackingPath(TEST_DOMAIN), "utf-8"))
    expect(after).not.toHaveProperty("20260607-nodown-a")
    expect(after).toHaveProperty("20260607-withdown-b")
  })

  test("rollback from tracking gap: stops at first untracked", async () => {
    const called: string[] = []

    const m1: Migration = {
      id: "20260610-gap-a",
      description: "Gap A (tracked)",
      async up() {},
      async down() {
        called.push("a")
      },
    }
    const m2: Migration = {
      id: "20260610-gap-b",
      description: "Gap B (not tracked)",
      async up() {},
      async down() {
        called.push("b")
      },
    }
    const m3: Migration = {
      id: "20260610-gap-c",
      description: "Gap C (tracked)",
      async up() {},
      async down() {
        called.push("c")
      },
    }

    MigrationRegistry.register(TEST_DOMAIN, [m1, m2, m3])

    // Run all — all get tracking entries
    await runMigrations({ targetDomain: TEST_DOMAIN })

    // Manually remove b's tracking entry to create a gap
    const p = trackingPath(TEST_DOMAIN)
    const logData = JSON.parse(readFileSync(p, "utf-8"))
    delete logData["20260610-gap-b"]
    writeFileSync(p, JSON.stringify(logData, null, 2))

    // Rollback newest: starts at c, hits b (untracked) → stops
    await rollbackMigrations(TEST_DOMAIN, "20260610-gap-c")

    // Only c rollback was attempted (b was untracked, breaks the chain)
    expect(called).toEqual(["c"])

    const after = JSON.parse(readFileSync(p, "utf-8"))
    expect(after).not.toHaveProperty("20260610-gap-c")
    expect(after).toHaveProperty("20260610-gap-a")
  })

  test("rollback of unknown migration in empty domain is a no-op", async () => {
    MigrationRegistry.register(TEST_DOMAIN, [])
    await rollbackMigrations(TEST_DOMAIN, "nonexistent")
    // No error — returns early when domain has no migrations
  })
})
