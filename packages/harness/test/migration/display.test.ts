import { describe, expect, test, afterEach } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { MigrationRegistry } from "../../src/migration/registry"
import { resetMigrations, runMigrations } from "../../src/migration"
import { afterAll as afterRuntimeTests } from "bun:test"
import { migrationFixture as testRuntime } from "./fixture"
const runtime = await testRuntime()

const TEST_DOMAIN = "test-display"

const trackingPath = (domain: string) => ["meta", "migration", `log-${domain}`]

describe("summary display when all domains up to date", () => {
  let originalWrite: typeof process.stderr.write

  afterEach(() =>
    runtime.run(async () => {
      process.stderr.write = originalWrite
      const p = trackingPath(TEST_DOMAIN)
      try {
        await Storage.remove(p)
      } catch {}
      MigrationRegistry.unregister(TEST_DOMAIN)
      resetMigrations()
    }),
  )

  test("a summary line is printed instead of per-domain status", () =>
    runtime.run(async () => {
      // Register a test migration, but pre-write its tracking entry so it
      // appears "already completed". After the fix, runMigrations prints a
      // single summary: "  ■■■■■■■■■■■■■■■■■■■■ N domains up to date"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const migration = {
        id: "20260615-display-test",
        description: "display test migration",
        async up() {},
      } as any
      MigrationRegistry.register(TEST_DOMAIN, [migration])

      // Pre-write tracking entry so the migration looks "completed"
      const p = trackingPath(TEST_DOMAIN)

      await Storage.write(p, { "20260615-display-test": Date.now() })

      // Capture stderr to inspect output
      originalWrite = process.stderr.write.bind(process.stderr)
      const output: string[] = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      process.stderr.write = ((chunk: any) => {
        output.push(String(chunk))
        return true
      }) as any

      await runMigrations({ targetDomain: TEST_DOMAIN })

      const allOutput = output.join("")
      // Summary line replaces per-domain status
      expect(allOutput).not.toContain(`[${TEST_DOMAIN}] Migrations up to date`)
      expect(allOutput).toContain("domain up to date")
    }))
})

afterRuntimeTests(() => runtime.close())
