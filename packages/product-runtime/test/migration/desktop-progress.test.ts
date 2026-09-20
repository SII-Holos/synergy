import { afterEach, describe, expect, test } from "bun:test"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { runMigrations } from "@ericsanchezok/synergy-harness/migration"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import {
  createManagedMaintenanceReporter,
  createManagedMigrationReporter,
  createManagedRecoveryReporter,
  createManagedStorageReporter,
} from "../../src/cli/managed-startup"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { RuntimeStartupProgress, RUNTIME_STARTUP_PREFIX } from "@ericsanchezok/synergy-util/runtime-startup"
import fs from "node:fs/promises"
import path from "node:path"

const domain = "test-desktop-progress"

afterEach(async () => {
  MigrationRegistry.unregister(domain)
  await Storage.remove(StoragePath.metaMigrationLogDomain(domain))
})

describe("desktop migration reporting", () => {
  test("preserves every maintenance transition without throttling or adding private data", () => {
    const lines: string[] = []
    const reporter = createManagedMaintenanceReporter((line) => lines.push(line))
    const events = [
      { phase: "maintenance", id: 1, state: "started", operation: "vacuum", timeoutMs: 690000 },
      { phase: "maintenance", id: 1, state: "stage", stage: "rewrite" },
      { phase: "maintenance", id: 1, state: "completed", elapsedMs: 123 },
    ] as const
    for (const event of events) reporter(event)
    expect(
      lines.map((line) => RuntimeStartupProgress.parse(JSON.parse(line.slice(RUNTIME_STARTUP_PREFIX.length)))),
    ).toEqual([...events])
  })

  test("streams real storage bootstrap and activation as bounded aggregate records", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, ".synergy")
    await fs.mkdir(path.join(root, "data", "notes", "scope"), { recursive: true })
    await Bun.write(path.join(root, "data", "notes", "scope", "private-name.json"), '{"text":"private payload"}')
    const lines: string[] = []
    let now = 0
    const reporter = createManagedStorageReporter(
      (line) => lines.push(line),
      () => now,
    )
    const prepared = await StorageBootstrap.prepare({
      root,
      progress: (progress) => {
        now += 31_000
        reporter(progress)
      },
    })
    try {
      await prepared.store.verify((current) => {
        now += 31_000
        reporter({ stage: "validate", current, total: 0, bytes: 0 })
      })
      await prepared.activate()
      const records = lines.map((line) =>
        RuntimeStartupProgress.parse(JSON.parse(line.slice(RUNTIME_STARTUP_PREFIX.length))),
      )
      expect(records[0]).toMatchObject({ phase: "storage", stage: "prepare", current: 0 })
      expect(
        records.some((record) => record.phase === "storage" && record.stage === "scan" && record.current === 1),
      ).toBe(true)
      expect(
        records.some((record) => record.phase === "storage" && record.stage === "activate" && record.current === 1),
      ).toBe(true)
      const checked = records.find(
        (record) => record.phase === "storage" && record.stage === "validate" && record.current > 0,
      )
      expect(checked).toBeDefined()
      expect(lines.join("")).not.toContain("private")
      expect(lines.join("")).not.toContain(root)
    } finally {
      await prepared.store.close()
    }
  })

  test("throttles advancing storage work and reports phase transitions immediately", () => {
    const lines: string[] = []
    let now = 0
    const reporter = createManagedStorageReporter(
      (line) => lines.push(line),
      () => now,
    )
    reporter({ stage: "scan", current: 0, total: 0, bytes: 0 })
    for (let current = 1; current < 1000; current++) reporter({ stage: "scan", current, total: 0, bytes: current })
    expect(lines).toHaveLength(1)
    now = 250
    reporter({ stage: "scan", current: 1000, total: 0, bytes: 1000 })
    reporter({ stage: "backup", current: 0, total: 1000, bytes: 0 })
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines.at(-1)!.slice(RUNTIME_STARTUP_PREFIX.length))).toMatchObject({ step: 2, stage: "backup" })
    now = 500
    reporter({ stage: "backup", current: 0, total: 1000, bytes: 0 })
    expect(lines).toHaveLength(3)
  })

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
