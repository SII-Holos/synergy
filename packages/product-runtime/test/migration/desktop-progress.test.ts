import { afterEach, describe, expect, test } from "bun:test"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { runMigrations } from "@ericsanchezok/synergy-harness/migration"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { createManagedMigrationReporter, createManagedRecoveryReporter } from "../../src/cli/managed-startup"

const domain = "test-desktop-progress"

afterEach(async () => {
  MigrationRegistry.unregister(domain)
  await Storage.remove(StoragePath.metaMigrationLogDomain(domain))
})

describe("desktop migration reporting", () => {
  test("reports recovery immediately, bounds output frequency and announces completion", () => {
    const lines: string[] = []
    let now = 0
    const reporter = createManagedRecoveryReporter(
      (line) => lines.push(line),
      () => now,
    )
    reporter.progress(0)
    expect(lines).toEqual(['SYNERGY_STARTUP_V1 {"phase":"recovery","current":0}\n'])
    for (let current = 1; current <= 1000; current++) reporter.progress(current)
    expect(lines).toHaveLength(1)
    now = 250
    reporter.progress(1001)
    expect(lines.at(-1)).toBe('SYNERGY_STARTUP_V1 {"phase":"recovery","current":1001}\n')
    now = 500
    for (const current of [1001, 0, -1, 1.5, Infinity]) reporter.progress(current)
    expect(lines).toHaveLength(2)
    reporter.completed()
    expect(lines.at(-1)).toBe('SYNERGY_STARTUP_V1 {"phase":"starting"}\n')
  })

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

  test("starts a new step for each explicit scan phase and ignores late phase reports", async () => {
    const lines: string[] = []
    MigrationRegistry.register(domain, [
      {
        id: "desktop-progress-phases",
        description: "Two scans with independent counters",
        async up(progress) {
          progress(10_000, 10_000)
          progress(0, 0, 1)
          progress(1, 2, 1)
          progress(2, 2, 1)
          progress(10_000, 10_000, 0)
        },
      },
    ])
    await runMigrations({
      targetDomain: domain,
      output: "silent",
      reporter: createManagedMigrationReporter((line) => lines.push(line)),
    })
    expect(lines).toContain('SYNERGY_STARTUP_V1 {"phase":"migration","step":2,"current":0,"total":0}\n')
    expect(lines.at(-2)).toBe('SYNERGY_STARTUP_V1 {"phase":"migration","step":2,"current":2,"total":2}\n')
    expect(lines.at(-1)).toBe('SYNERGY_STARTUP_V1 {"phase":"starting"}\n')
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
