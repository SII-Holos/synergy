import { describe, expect, test, afterEach } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { MigrationRegistry } from "../../src/migration/registry"
import { resetMigrations, runMigrations } from "../../src/migration"
import type { Migration } from "../../src/migration/types"
import { afterAll as afterRuntimeTests } from "bun:test"
import { migrationFixture } from "./fixture"
const runtime = await migrationFixture()

const TEST_DOMAIN = "conc-test"
const domainLogPath = (domain: string) => ["meta", "migration", `log-${domain}`]
const legacyLogPath = () => ["meta", "migration", "log"]
const writeLog = Storage.write

describe("concurrent migration tracking writes", () => {
  afterEach(() =>
    runtime.run(async () => {
      for (const key of [
        domainLogPath(TEST_DOMAIN),
        domainLogPath("library"),
        domainLogPath("engram"),
        legacyLogPath(),
      ])
        await Storage.remove(key)
      MigrationRegistry.unregister(TEST_DOMAIN)
      resetMigrations()
    }),
  )

  test("completion markers from another task are merged, not overwritten", () =>
    runtime.run(async () => {
      let markEntered!: () => void
      const entered = new Promise<void>((resolve) => (markEntered = resolve))
      let releaseA!: () => void
      const gateA = new Promise<void>((resolve) => (releaseA = resolve))

      const mA: Migration = {
        id: "20260806-conc-a",
        description: "Conc A",
        async up() {
          markEntered()
          await gateA
        },
      }
      // Task A only knows about mA (e.g. an older CLI whose registry lacks mB).
      MigrationRegistry.register(TEST_DOMAIN, [mA])

      const runPromise = runMigrations({ output: "silent", targetDomain: TEST_DOMAIN })
      await entered

      // Task B (the same namespace owner) completes mB while A is still running mA.
      await writeLog(domainLogPath(TEST_DOMAIN), { "20260806-conc-b": Date.now() })

      releaseA()
      await runPromise

      const data = await Storage.read(domainLogPath(TEST_DOMAIN))
      expect(data).toHaveProperty("20260806-conc-a")
      // A's save must not drop B's marker.
      expect(data).toHaveProperty("20260806-conc-b")
    }))

  test("legacy single-log conversion merges, not overwrites, per-domain markers", () =>
    runtime.run(async () => {
      const mA: Migration = {
        id: "20260806-conc-a",
        description: "Conc A",
        async up() {},
      }
      MigrationRegistry.register(TEST_DOMAIN, [mA])

      // Old-version single log plus a marker another instance already persisted
      // in the per-domain log before this instance converts the old format.
      await writeLog(legacyLogPath(), { "20260806-conc-a": Date.now() })
      await writeLog(domainLogPath(TEST_DOMAIN), { "20260806-conc-b": Date.now() })

      await runMigrations({ output: "silent", targetDomain: TEST_DOMAIN })

      // The old single log is consumed.
      expect((await Storage.readMany([legacyLogPath()]))[0]).toBeUndefined()
      const data = await Storage.read(domainLogPath(TEST_DOMAIN))
      expect(data).toHaveProperty("20260806-conc-a")
      // Conversion must not drop the concurrent per-domain marker.
      expect(data).toHaveProperty("20260806-conc-b")
    }))
})

afterRuntimeTests(() => runtime.close())
