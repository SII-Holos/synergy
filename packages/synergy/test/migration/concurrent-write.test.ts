import { describe, expect, test, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs"
import path from "node:path"
import { MigrationRegistry } from "../../src/migration/registry"
import { resetMigrations, runMigrations } from "../../src/migration"
import type { Migration } from "../../src/migration/types"

const dataDir = path.join(process.env["SYNERGY_TEST_HOME"]!, ".synergy", "data")
const TEST_DOMAIN = "conc-test"

function domainLogPath(domain: string): string {
  return path.join(dataDir, "meta", "migration", `log-${domain}.json`)
}

function legacyLogPath(): string {
  return path.join(dataDir, "meta", "migration", "log.json")
}

function writeLog(filePath: string, data: Record<string, number>): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(data))
}

describe("concurrent migration tracking writes", () => {
  afterEach(() => {
    for (const file of [
      domainLogPath(TEST_DOMAIN),
      domainLogPath("library"),
      domainLogPath("engram"),
      legacyLogPath(),
    ]) {
      try {
        unlinkSync(file)
      } catch {}
    }
    MigrationRegistry.list().delete(TEST_DOMAIN)
    resetMigrations()
  })

  test("completion markers from another instance are merged, not overwritten", async () => {
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
    // Instance A only knows about mA (e.g. an older CLI whose registry lacks mB).
    MigrationRegistry.register(TEST_DOMAIN, [mA])

    const runPromise = runMigrations({ output: "silent", targetDomain: TEST_DOMAIN })
    await entered

    // Instance B (a concurrent process) completes mB while A is still running mA.
    writeLog(domainLogPath(TEST_DOMAIN), { "20260806-conc-b": Date.now() })

    releaseA()
    await runPromise

    const data = JSON.parse(readFileSync(domainLogPath(TEST_DOMAIN), "utf-8"))
    expect(data).toHaveProperty("20260806-conc-a")
    // A's save must not drop B's marker.
    expect(data).toHaveProperty("20260806-conc-b")
  })

  test("legacy single-log conversion merges, not overwrites, per-domain markers", async () => {
    const mA: Migration = {
      id: "20260806-conc-a",
      description: "Conc A",
      async up() {},
    }
    MigrationRegistry.register(TEST_DOMAIN, [mA])

    // Old-version single log plus a marker another instance already persisted
    // in the per-domain log before this instance converts the old format.
    writeLog(legacyLogPath(), { "20260806-conc-a": Date.now() })
    writeLog(domainLogPath(TEST_DOMAIN), { "20260806-conc-b": Date.now() })

    await runMigrations({ output: "silent", targetDomain: TEST_DOMAIN })

    // The old single log is consumed.
    expect(existsSync(legacyLogPath())).toBe(false)
    const data = JSON.parse(readFileSync(domainLogPath(TEST_DOMAIN), "utf-8"))
    expect(data).toHaveProperty("20260806-conc-a")
    // Conversion must not drop the concurrent per-domain marker.
    expect(data).toHaveProperty("20260806-conc-b")
  })
})
