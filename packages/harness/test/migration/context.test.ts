import { describe, expect, test, afterEach } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { MigrationRegistry } from "../../src/migration/registry"
import { resetMigrations, runMigrations } from "../../src/migration"
import type { MigrationContext } from "../../src/migration/types"

const TEST_DOMAIN = "test-context"

const trackingPath = (domain: string) => ["meta", "migration", `log-${domain}`]

describe("two-param up() receives MigrationContext", () => {
  afterEach(async () => {
    const p = trackingPath(TEST_DOMAIN)
    try {
      await Storage.remove(p)
    } catch {}
    MigrationRegistry.unregister(TEST_DOMAIN)
    resetMigrations()
  })

  test("up(ctx, progress) receives correct context on non-dry run", async () => {
    // When up() has arity 2, the current code only passes (progressCb)
    // instead of (ctx, progressCb). This means ctx receives the progress
    // function rather than MigrationContext — ctx.appVersion will be
    // undefined and ctx.dryRun will be undefined.
    const receivedCtx: MigrationContext[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const migration = {
      id: "20260615-context-test",
      description: "context test",
      async up(ctx: MigrationContext, _progress: (c: number, t: number) => void) {
        receivedCtx.push(ctx)
      },
      // Arity 2 triggers the else branch in the arity-detection block
    } as any
    MigrationRegistry.register(TEST_DOMAIN, [migration])
    await runMigrations({ targetDomain: TEST_DOMAIN })

    expect(receivedCtx).toHaveLength(1)

    const ctx = receivedCtx[0]
    // These assertions verify ctx is a real MigrationContext, not a function
    expect(typeof ctx.appVersion).toBe("string")
    expect(ctx.appVersion.length).toBeGreaterThan(0)
    expect(ctx.dryRun).toBe(false)
    expect(typeof ctx.log).toBe("function")
  })
})
