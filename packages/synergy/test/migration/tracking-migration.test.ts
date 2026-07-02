import { describe, expect, test, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, existsSync, unlinkSync, readFileSync } from "node:fs"
import path from "node:path"
import { MigrationRegistry } from "../../src/migration/registry"
import { resetMigrations, runMigrations } from "../../src/migration"
import type { Migration } from "../../src/migration/types"

const dataDir = path.join(process.env["SYNERGY_TEST_HOME"]!, ".synergy", "data")

const oldLogPath = path.join(dataDir, "meta", "migration", "log.json")
const TEST_DOMAINS = ["track-test-a", "track-test-b", "track-test-c"]

function domainLogPath(domain: string): string {
  return path.join(dataDir, "meta", "migration", `log-${domain}.json`)
}

describe("tracking data migration (log.json → log-{domain}.json)", () => {
  afterEach(() => {
    // Clean up test tracking files
    try {
      unlinkSync(oldLogPath)
    } catch {}
    for (const domain of TEST_DOMAINS) {
      try {
        unlinkSync(domainLogPath(domain))
      } catch {}
      MigrationRegistry.list().delete(domain)
    }
    // Remove any other log files in the migration dir
    const metaDir = path.join(dataDir, "meta", "migration")
    try {
      const dir = Array.from(new Bun.Glob("*.json").scanSync({ cwd: metaDir, onlyFiles: true }))
      for (const file of dir) {
        if (file.startsWith("log-")) {
          const p = path.join(metaDir, file)
          if (p !== oldLogPath && !TEST_DOMAINS.some((d) => p === domainLogPath(d))) {
            try {
              unlinkSync(p)
            } catch {}
          }
        }
      }
    } catch {}
    resetMigrations()
  })

  test("migrates old log.json to per-domain log files", async () => {
    const now = Date.now()

    // Register test migrations
    const mA: Migration = {
      id: "20260609-track-a",
      description: "Track A",
      async up() {},
    }
    const mB: Migration = {
      id: "20260609-track-b",
      description: "Track B",
      async up() {},
    }
    const mC: Migration = {
      id: "20260609-track-c",
      description: "Track C",
      async up() {},
    }

    MigrationRegistry.register(TEST_DOMAINS[0], [mA])
    MigrationRegistry.register(TEST_DOMAINS[1], [mB])
    MigrationRegistry.register(TEST_DOMAINS[2], [mC])

    // Create the old log.json with entries
    mkdirSync(path.dirname(oldLogPath), { recursive: true })
    const oldLog: Record<string, number> = {
      "20260609-track-a": now,
      "20260609-track-b": now + 1,
      "20260609-track-c": now + 2,
    }
    writeFileSync(oldLogPath, JSON.stringify(oldLog, null, 2))

    // runMigrations always migrates old tracking data before applying the target
    // domain filter, so one test domain is enough to exercise the split without
    // running every real repository migration.
    await runMigrations({ output: "silent", targetDomain: TEST_DOMAINS[0] })

    // Old log should be deleted
    expect(existsSync(oldLogPath)).toBe(false)

    // Per-domain logs should exist
    for (const [i, domain] of TEST_DOMAINS.entries()) {
      const p = domainLogPath(domain)
      expect(existsSync(p)).toBe(true)
      const data = JSON.parse(readFileSync(p, "utf-8"))
      const expectedKeys = i === 0 ? ["20260609-track-a"] : i === 1 ? ["20260609-track-b"] : ["20260609-track-c"]
      for (const key of expectedKeys) {
        expect(data).toHaveProperty(key)
      }
    }
  })

  test("idempotent: running twice is a no-op", async () => {
    const mA: Migration = {
      id: "20260610-idem-a",
      description: "Idempotent A",
      async up() {},
    }

    MigrationRegistry.register(TEST_DOMAINS[0], [mA])

    // Create old log
    mkdirSync(path.dirname(oldLogPath), { recursive: true })
    writeFileSync(oldLogPath, JSON.stringify({ "20260610-idem-a": Date.now() }))

    // First run: migrates old log
    await runMigrations({ output: "silent", targetDomain: TEST_DOMAINS[0] })
    expect(existsSync(oldLogPath)).toBe(false)

    const firstData = JSON.parse(readFileSync(domainLogPath(TEST_DOMAINS[0]), "utf-8"))

    // Clear completed state so we can run again
    resetMigrations()

    // Second run: no old log to migrate, no new migrations to run
    await runMigrations({ output: "silent", targetDomain: TEST_DOMAINS[0] })
    expect(existsSync(oldLogPath)).toBe(false)

    const secondData = JSON.parse(readFileSync(domainLogPath(TEST_DOMAINS[0]), "utf-8"))
    expect(secondData).toEqual(firstData)
  })

  test("no old log file: migration is a no-op", async () => {
    const mA: Migration = {
      id: "20260611-noold-a",
      description: "No old log A",
      async up() {},
    }

    MigrationRegistry.register(TEST_DOMAINS[0], [mA])

    // No old log file, and no per-domain log yet
    expect(existsSync(oldLogPath)).toBe(false)
    expect(existsSync(domainLogPath(TEST_DOMAINS[0]))).toBe(false)

    // This should just run the migration (since it's not tracked)
    // Actually, running with targetDomain to avoid running all real migrations
    await runMigrations({ output: "silent", targetDomain: TEST_DOMAINS[0] })

    // The migration runs and creates the per-domain tracking file
    const p = domainLogPath(TEST_DOMAINS[0])
    expect(existsSync(p)).toBe(true)
    const data = JSON.parse(readFileSync(p, "utf-8"))
    expect(data).toHaveProperty("20260611-noold-a")
  })
})
