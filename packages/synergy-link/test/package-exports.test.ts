import { describe, expect, test } from "bun:test"

describe("synergy-link package entry points", () => {
  test("index barrel re-exports the public runtime surface", async () => {
    const pkg = await import("../src/index.ts")
    expect(pkg.SynergyLinkRuntime).toBeDefined()
    expect(pkg.SynergyLinkStore).toBeDefined()
    expect(pkg.SynergyLinkHolosClient).toBeDefined()
    expect(pkg.SynergyLinkHolosLogin).toBeDefined()
    expect(pkg.ProcessRegistry).toBeDefined()
    expect(pkg.RPCHandler).toBeDefined()
    expect(pkg.SessionManager).toBeDefined()
    expect(pkg.Platform).toBeDefined()
    expect(pkg.SynergyLinkLog).toBeDefined()
    expect(pkg.SynergyLinkHost).toBeDefined()
    expect(pkg.SynergyLinkInboundHandler).toBeDefined()
  })

  test("migration type contract keeps its runnable shape", async () => {
    const types = await import("../src/migration/types.ts")
    const migration: import("../src/migration/types.ts").SynergyLinkMigration = {
      id: "probe",
      description: "probe migration",
      async run() {
        return undefined
      },
    }
    expect(types).toBeTruthy()
    expect(migration.id).toBe("probe")
    await expect(migration.run()).resolves.toBeUndefined()
  })
})
