import { expect, test } from "bun:test"
import { createManagedMigrationReporter } from "../../src/cli/managed-startup"
import { RUNTIME_STARTUP_PREFIX, RuntimeStartupProgress } from "@ericsanchezok/synergy-util/runtime-startup"

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
