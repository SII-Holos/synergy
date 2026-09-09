import { expect, test } from "bun:test"
import { createIsolatedTestEnv } from "@ericsanchezok/synergy-testing/env"

test("runtime registration lock rejects late migration domains without changing legacy tracking", async () => {
  const isolated = await createIsolatedTestEnv()
  const registry = new URL("../../src/migration/registry.ts", import.meta.url).pathname
  const migration = new URL("../../src/migration/index.ts", import.meta.url).pathname
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--eval",
      `
      import assert from "node:assert/strict"
      import fs from "node:fs/promises"
      import path from "node:path"
      const { MigrationRegistry } = await import(${JSON.stringify(registry)})
      const { runMigrations } = await import(${JSON.stringify(migration)})
      const known = [{ id: "registered-before-open", description: "Known", dependsOn: [], async up() {} }]
      MigrationRegistry.register("known-before-open", known)
      const file = path.join(process.env.SYNERGY_TEST_HOME, ".synergy/data/meta/migration/log.json")
      const legacy = { "optional-late": { id: "optional-late", status: "completed", timestamp: 123 } }
      await fs.mkdir(path.dirname(file), { recursive: true })
      await Bun.write(file, JSON.stringify(legacy))
      const snapshot = MigrationRegistry.list()
      snapshot.get("known-before-open")[0].id = "changed-via-snapshot"
      snapshot.get("known-before-open")[0].dependsOn.push("missing")
      snapshot.get("known-before-open").push({ id: "injected", description: "Injected", async up() {} })
      snapshot.set("injected-domain", [])
      known[0].description = "changed-via-original"
      assert.equal(MigrationRegistry.list().get("known-before-open")[0].id, "registered-before-open")
      assert.equal(MigrationRegistry.list().get("known-before-open")[0].description, "Known")
      assert.deepEqual(MigrationRegistry.list().get("known-before-open")[0].dependsOn, [])
      assert.equal(MigrationRegistry.list().get("known-before-open").length, 1)
      assert.equal(MigrationRegistry.list().has("injected-domain"), false)
      MigrationRegistry.lock()
      assert.doesNotThrow(() => MigrationRegistry.register("known-before-open", known))
      assert.throws(() => MigrationRegistry.unregister("known-before-open"), /before opening the runtime/)
      MigrationRegistry.list().clear()
      assert.equal(MigrationRegistry.list().has("known-before-open"), true)
      assert.throws(() => MigrationRegistry.register("known-before-open", [...known]), /before opening the runtime/)
      assert.throws(() => MigrationRegistry.register("optional-late", [{ id: "optional-late", description: "Late", async up() {} }]), /before opening the runtime/)
      await runMigrations({ targetDomain: "known-before-open", output: "silent" })
      assert.deepEqual(JSON.parse(await Bun.file(file).text()), legacy)
      assert.equal(MigrationRegistry.list().has("optional-late"), false)
    `,
    ],
    stdout: "pipe",
    stderr: "pipe",
    env: isolated.env,
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  await isolated.dispose()
  expect(code, stderr).toBe(0)
})
