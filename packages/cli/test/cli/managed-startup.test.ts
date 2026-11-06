import { expect, test } from "bun:test"
import {
  createManagedMigrationReporter,
  createManagedStartupReporter,
  createManagedStorageReporter,
} from "../../src/cli/managed-startup"
import { RUNTIME_STARTUP_PREFIX, RuntimeStartupProgress } from "@ericsanchezok/synergy-util/runtime-startup"

test("Runtime stage transitions and readiness bypass count throttling without inventing activity", () => {
  const lines: string[] = []
  let now = 0
  const report = createManagedStartupReporter(
    (line) => lines.push(line),
    () => now,
  )
  report({ phase: "runtime", state: "opening", stage: "extensions", current: 0 })
  for (let current = 1; current <= 100; current++)
    report({ phase: "runtime", state: "opening", stage: "extensions", current })
  expect(lines).toHaveLength(1)
  now = 250
  report({ phase: "runtime", state: "opening", stage: "extensions", current: 100 })
  report({ phase: "runtime", state: "opening", stage: "finalizing", current: 0 })
  report({ phase: "runtime", state: "ready" })
  now = 1000
  report({ phase: "runtime", state: "opening", stage: "extensions", current: 101 })
  expect(lines.map((line) => JSON.parse(line.slice(RUNTIME_STARTUP_PREFIX.length)))).toEqual([
    { phase: "runtime", state: "opening", stage: "extensions", current: 0 },
    { phase: "runtime", state: "opening", stage: "extensions", current: 100 },
    { phase: "runtime", state: "opening", stage: "finalizing", current: 0 },
    { phase: "runtime", state: "ready" },
  ])
})

test("a recovery stage announces a discovered total before its first item completes", () => {
  const lines: string[] = []
  const report = createManagedStorageReporter(
    (line) => lines.push(line),
    () => 0,
  )
  report({ stage: "owners", current: 0, total: 0, bytes: 0 })
  report({ stage: "owners", current: 0, total: 10, bytes: 0 })
  report({ stage: "owners", current: 0, total: 10, bytes: 0 })
  expect(lines).toHaveLength(2)
  expect(JSON.parse(lines.at(-1)!.slice(RUNTIME_STARTUP_PREFIX.length))).toMatchObject({
    phase: "storage",
    stage: "owners",
    step: 1,
    current: 0,
    total: 10,
  })
})

test("managed migration tasks describe real work without exposing migration metadata", () => {
  const lines: string[] = []
  const reporter = createManagedMigrationReporter((line) => lines.push(line))
  const migration = {
    id: "20261003-session-turn-file-checkpoints",
    description: "private fixture metadata",
    async up() {},
  }
  reporter.started?.({ domain: "session", migration })
  reporter.progress?.({ domain: "session", migration, current: 256, total: 0, dryRun: false })
  expect(
    lines.map((line) => RuntimeStartupProgress.parse(JSON.parse(line.slice(RUNTIME_STARTUP_PREFIX.length)))),
  ).toEqual([
    { phase: "migration", step: 1, current: 0, total: 0, task: "file-history" },
    { phase: "migration", step: 1, current: 256, total: 0, task: "file-history" },
  ])
  expect(lines.join("")).not.toContain(migration.id)
  expect(lines.join("")).not.toContain(migration.description)
  reporter.started?.({ domain: "tool-input-local-runtime", migration })
  expect(JSON.parse(lines.at(-1)!.slice(RUNTIME_STARTUP_PREFIX.length))).toMatchObject({
    task: "tool-history",
    step: 2,
  })
  reporter.started?.({ domain: "scope", migration })
  expect(JSON.parse(lines.at(-1)!.slice(RUNTIME_STARTUP_PREFIX.length))).toMatchObject({ task: "scopes", step: 3 })
  reporter.started?.({ domain: "private-domain", migration })
  expect(JSON.parse(lines.at(-1)!.slice(RUNTIME_STARTUP_PREFIX.length))).toEqual({
    phase: "migration",
    step: 4,
    current: 0,
    total: 0,
  })
})
