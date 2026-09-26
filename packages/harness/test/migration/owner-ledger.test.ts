import { expect, test } from "bun:test"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("optional migration owners retain their original ledger and leave unloaded entries intact", () =>
  runtime.run(async () => {
    const isolated = await createIsolatedTestEnv()
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--eval",
        `
      import assert from "node:assert/strict"
      import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
      import { registerHarness } from "@ericsanchezok/synergy-harness/lifecycle"
      import path from "node:path"
      const home = process.env.SYNERGY_HOME || process.env.SYNERGY_TEST_HOME
      const context = RuntimeContext.create({ home, root: path.join(home, ".synergy"), env: { ...process.env } })
      await context.run(async () => {
      registerHarness()

      const { StorageMaintenance } = await import("@ericsanchezok/synergy-harness/storage/maintenance")
      await using storageHandle = await StorageMaintenance.open({ migrate: false })
      const { MigrationRegistry } = await import("@ericsanchezok/synergy-harness/migration/registry")
      const { runMigrations } = await import("@ericsanchezok/synergy-harness/migration")
      const { Storage } = await import("@ericsanchezok/synergy-harness/storage/storage")
      const { StoragePath } = await import("@ericsanchezok/synergy-harness/storage/path")
      const ledger = StoragePath.metaMigrationLogDomain("legacy-ledger")
      const previous = { "old-completed": 42, "still-unloaded": 24 }
      await Storage.write(ledger, previous)
      await runMigrations({ targetDomain: "legacy-ledger", output: "silent" })
      assert.deepEqual(await Storage.read(ledger), previous)
      let applied = 0
      MigrationRegistry.register("new-owner", [
        { id: "old-completed", domain: "legacy-ledger", description: "Existing", async up() { throw new Error("must not rerun") } },
        { id: "pending", domain: "legacy-ledger", description: "Pending", async up() { applied++ } },
      ])
      const summary = await runMigrations({ targetDomain: "legacy-ledger", output: "silent" })
      assert.equal(summary.completed, 1)
      assert.equal(applied, 1)
      const after = await Storage.read(ledger)
      assert.equal(after["old-completed"], 42)
      assert.equal(after["still-unloaded"], 24)
      assert.equal(typeof after.pending, "number")
      await runMigrations({ targetDomain: "legacy-ledger", output: "silent" })
      assert.equal(applied, 1)
      assert.equal(await Storage.read(StoragePath.metaMigrationLogDomain("new-owner")).catch(() => undefined), undefined)
      })
      context.dispose()
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
