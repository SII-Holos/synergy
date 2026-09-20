import { expect, test } from "bun:test"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "./support/runtime"
const runtime = await testRuntime()

test("legacy Library tracking stays untouched until its owner registers", () =>
  runtime.run(async () => {
    const isolated = await createIsolatedTestEnv()
    const entry = new URL("../src/migration.ts", import.meta.url).pathname
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--eval",
        `
      import assert from "node:assert/strict"
      const { runMigrations } = await import("@ericsanchezok/synergy-harness/migration")
      const { Storage } = await import("@ericsanchezok/synergy-harness/storage/storage")
      const { StoragePath } = await import("@ericsanchezok/synergy-harness/storage/path")
      const { StorageMaintenance } = await import("@ericsanchezok/synergy-harness/storage/maintenance")
      const { RuntimeContext } = await import("@ericsanchezok/synergy-harness/lifecycle/context")
      const { registerHarness } = await import("@ericsanchezok/synergy-harness/lifecycle")
      const path = await import("node:path")
      const home = process.env.SYNERGY_TEST_HOME
      const owner = RuntimeContext.create({ home, root: path.join(home, ".synergy"), env: process.env })
      await owner.run(async () => {
      registerHarness()
      await using maintenance = await StorageMaintenance.open({ migrate: false })
      const oldKey = StoragePath.metaMigrationLogDomain("engram")
      const newKey = StoragePath.metaMigrationLogDomain("library")
      const old = { "20260324-engram-experience-source-model": 42, "unknown-engram-step": 24 }
      const existing = { "20260324-library-experience-source-model": 99 }
      await Storage.write(oldKey, old)
      await Storage.write(newKey, existing)
      await runMigrations({ targetDomain: "absent", output: "silent" })
      assert.deepEqual(await Storage.read(oldKey), old)
      assert.deepEqual(await Storage.read(newKey), existing)
      const { registerLibraryMigrations } = await import(${JSON.stringify(entry)})
      registerLibraryMigrations()
      await runMigrations({ targetDomain: "absent", output: "silent" })
      assert.equal(await Storage.read(oldKey).catch(() => undefined), undefined)
      assert.deepEqual(await Storage.read(newKey), { ...existing, "unknown-library-step": 24 })
      await runMigrations({ targetDomain: "absent", output: "silent" })
      assert.deepEqual(await Storage.read(newKey), { ...existing, "unknown-library-step": 24 })
      })
      owner.dispose()
    `,
      ],
      env: isolated.env,
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect(code, stderr).toBe(0)
    } finally {
      await isolated.dispose()
    }
  }))

afterRuntimeTests(() => runtime.close())
