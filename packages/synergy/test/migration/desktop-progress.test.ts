import { afterEach, describe, expect, test } from "bun:test"
import { MigrationRegistry } from "../../src/migration/registry"
import { runMigrations } from "../../src/migration"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { createManagedMigrationReporter } from "../../src/cli/managed-startup"

const domain = "test-desktop-progress"

afterEach(async () => {
  MigrationRegistry.list().delete(domain)
  await Storage.remove(StoragePath.metaMigrationLogDomain(domain))
})

describe("desktop migration reporting", () => {
  test("announces pending work before it runs and returns to startup only after completion", async () => {
    const lines: string[] = []
    const reporter = createManagedMigrationReporter((line) => lines.push(line))
    MigrationRegistry.register(domain, [
      {
        id: "desktop-progress-upgrade",
        description: "A private migration description must not reach Desktop",
        async up(progress) {
          expect(lines).toEqual(['SYNERGY_STARTUP_V1 {"phase":"migration","step":1,"current":0,"total":0}\n'])
          progress(1, 2)
          progress(2, 2)
        },
      },
    ])
    await runMigrations({ targetDomain: domain, output: "silent", reporter })
    expect(lines.at(-2)).toBe('SYNERGY_STARTUP_V1 {"phase":"migration","step":1,"current":2,"total":2}\n')
    expect(lines.at(-1)).toBe('SYNERGY_STARTUP_V1 {"phase":"starting"}\n')
    lines.length = 0
    await runMigrations({
      targetDomain: domain,
      output: "silent",
      reporter: createManagedMigrationReporter((line) => lines.push(line)),
    })
    expect(lines).toEqual(['SYNERGY_STARTUP_V1 {"phase":"starting"}\n'])
  })

  test("a failed migration is retried without reporting successful startup", async () => {
    const lines: string[] = []
    let fail = true
    MigrationRegistry.register(domain, [
      {
        id: "desktop-progress-retry",
        description: "Retry fixture",
        async up() {
          if (fail) throw new Error("fixture interrupted")
        },
      },
    ])
    const run = () =>
      runMigrations({
        targetDomain: domain,
        output: "silent",
        reporter: createManagedMigrationReporter((line) => lines.push(line)),
      })
    await expect(run()).rejects.toThrow("fixture interrupted")
    expect(lines).toHaveLength(1)
    fail = false
    await run()
    expect(lines).toHaveLength(3)
    expect(lines.at(-1)).toBe('SYNERGY_STARTUP_V1 {"phase":"starting"}\n')
  })
})
