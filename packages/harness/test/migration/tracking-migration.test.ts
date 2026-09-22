import { describe, expect, test, afterEach } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { MigrationRegistry } from "../../src/migration/registry"
import { resetMigrations, runMigrations } from "../../src/migration"
import type { Migration } from "../../src/migration/types"
import { afterAll as afterRuntimeTests } from "bun:test"
import { migrationFixture as testRuntime } from "./fixture"
const runtime = await testRuntime()

const oldLogPath = ["meta", "migration", "log"]
const TEST_DOMAINS = ["track-test-a", "track-test-b", "track-test-c"]

const domainLogPath = (domain: string) => ["meta", "migration", `log-${domain}`]

describe("tracking data migration (log.json → log-{domain}.json)", () => {
  afterEach(() =>
    runtime.run(async () => {
      // Clean up test tracking files
      try {
        await Storage.remove(oldLogPath)
      } catch {}
      for (const domain of TEST_DOMAINS) {
        try {
          await Storage.remove(domainLogPath(domain))
        } catch {}
        MigrationRegistry.unregister(domain)
      }
      resetMigrations()
    }),
  )

  test("migrates old log.json to per-domain log files", () =>
    runtime.run(async () => {
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

      const oldLog: Record<string, number> = {
        "20260609-track-a": now,
        "20260609-track-b": now + 1,
        "20260609-track-c": now + 2,
      }
      await Storage.write(oldLogPath, oldLog)

      // runMigrations always migrates old tracking data before applying the target
      // domain filter, so one test domain is enough to exercise the split without
      // running every real repository migration.
      await runMigrations({ output: "silent", targetDomain: TEST_DOMAINS[0] })

      // Old log should be deleted
      expect((await Storage.readMany([oldLogPath]))[0] !== undefined).toBe(false)

      // Per-domain logs should exist
      for (const [i, domain] of TEST_DOMAINS.entries()) {
        const p = domainLogPath(domain)
        expect((await Storage.readMany([p]))[0] !== undefined).toBe(true)
        const data = await Storage.read<Record<string, number>>(p)
        const expectedKeys = i === 0 ? ["20260609-track-a"] : i === 1 ? ["20260609-track-b"] : ["20260609-track-c"]
        for (const key of expectedKeys) {
          expect(data).toHaveProperty(key)
        }
      }
    }))

  test("idempotent: running twice is a no-op", () =>
    runtime.run(async () => {
      const mA: Migration = {
        id: "20260610-idem-a",
        description: "Idempotent A",
        async up() {},
      }

      MigrationRegistry.register(TEST_DOMAINS[0], [mA])

      // Create old log

      await Storage.write(oldLogPath, { "20260610-idem-a": Date.now() })

      // First run: migrates old log
      await runMigrations({ output: "silent", targetDomain: TEST_DOMAINS[0] })
      expect((await Storage.readMany([oldLogPath]))[0] !== undefined).toBe(false)

      const firstData = await Storage.read<Record<string, number>>(domainLogPath(TEST_DOMAINS[0]))

      // Clear completed state so we can run again
      resetMigrations()

      // Second run: no old log to migrate, no new migrations to run
      await runMigrations({ output: "silent", targetDomain: TEST_DOMAINS[0] })
      expect((await Storage.readMany([oldLogPath]))[0] !== undefined).toBe(false)

      const secondData = await Storage.read<Record<string, number>>(domainLogPath(TEST_DOMAINS[0]))
      expect(secondData).toEqual(firstData)
    }))

  test("retains unregistered migration history until its domain is installed", () =>
    runtime.run(async () => {
      const knownID = "20260908-track-known"
      const deferredID = "20260908-track-deferred"
      let executed = 0
      const migration = (id: string): Migration => ({
        id,
        description: id,
        async up() {
          executed++
        },
      })
      MigrationRegistry.register(TEST_DOMAINS[0], [migration(knownID)])

      await Storage.write(oldLogPath, { [knownID]: 100, [deferredID]: 200 })

      await runMigrations({ output: "silent", targetDomain: TEST_DOMAINS[0] })
      expect(await Storage.read<Record<string, number>>(domainLogPath(TEST_DOMAINS[0]))).toEqual({ [knownID]: 100 })
      expect(await Storage.read<Record<string, number>>(oldLogPath)).toEqual({ [deferredID]: 200 })

      await runMigrations({ output: "silent", targetDomain: TEST_DOMAINS[0] })
      expect(await Storage.read<Record<string, number>>(oldLogPath)).toEqual({ [deferredID]: 200 })

      MigrationRegistry.register(TEST_DOMAINS[1], [migration(deferredID)])
      await runMigrations({ output: "silent", targetDomain: TEST_DOMAINS[1] })
      expect(await Storage.read<Record<string, number>>(domainLogPath(TEST_DOMAINS[1]))).toEqual({ [deferredID]: 200 })
      expect((await Storage.readMany([oldLogPath]))[0] !== undefined).toBe(false)
      expect(executed).toBe(0)
    }))

  test("keeps a legacy log unchanged when none of its migrations are registered", () =>
    runtime.run(async () => {
      const legacy = { "20260908-uninstalled-domain": 123 }

      await Storage.write(oldLogPath, legacy)

      await runMigrations({ output: "silent", targetDomain: TEST_DOMAINS[0] })

      expect(await Storage.read<Record<string, number>>(oldLogPath)).toEqual(legacy)
      expect((await Storage.readMany([domainLogPath(TEST_DOMAINS[0])]))[0] !== undefined).toBe(false)
    }))

  test("no old log file: migration is a no-op", () =>
    runtime.run(async () => {
      const mA: Migration = {
        id: "20260611-noold-a",
        description: "No old log A",
        async up() {},
      }

      MigrationRegistry.register(TEST_DOMAINS[0], [mA])

      // No old log file, and no per-domain log yet
      expect((await Storage.readMany([oldLogPath]))[0] !== undefined).toBe(false)
      expect((await Storage.readMany([domainLogPath(TEST_DOMAINS[0])]))[0] !== undefined).toBe(false)

      // This should just run the migration (since it's not tracked)
      // Actually, running with targetDomain to avoid running all real migrations
      await runMigrations({ output: "silent", targetDomain: TEST_DOMAINS[0] })

      // The migration runs and creates the per-domain tracking file
      const p = domainLogPath(TEST_DOMAINS[0])
      expect((await Storage.readMany([p]))[0] !== undefined).toBe(true)
      const data = await Storage.read<Record<string, number>>(p)
      expect(data).toHaveProperty("20260611-noold-a")
    }))
})

afterRuntimeTests(() => runtime.close())
