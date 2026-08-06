import { describe, expect, test, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs"
import path from "node:path"
import { MigrationRegistry } from "../../src/migration/registry"
import { resetMigrations, runMigrations } from "../../src/migration"
import type { Migration } from "../../src/migration/types"

const dataDir = path.join(process.env["SYNERGY_TEST_HOME"]!, ".synergy", "data")
const TEST_DOMAIN = "conc-test"

function domainLogPath(domain: string): string {
  return path.join(dataDir, "meta", "migration", `log-${domain}.json`)
}

describe("concurrent migration tracking writes", () => {
  afterEach(() => {
    try {
      unlinkSync(domainLogPath(TEST_DOMAIN))
    } catch {}
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
    mkdirSync(path.dirname(domainLogPath(TEST_DOMAIN)), { recursive: true })
    writeFileSync(domainLogPath(TEST_DOMAIN), JSON.stringify({ "20260806-conc-b": Date.now() }))

    releaseA()
    await runPromise

    const data = JSON.parse(readFileSync(domainLogPath(TEST_DOMAIN), "utf-8"))
    expect(data).toHaveProperty("20260806-conc-a")
    // A's save must not drop B's marker.
    expect(data).toHaveProperty("20260806-conc-b")
  })
})
