import { expect, test } from "bun:test"

test("library composes independently without product registration or plugin delivery", async () => {
  const entry = new URL("../src/register.ts", import.meta.url).pathname
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--eval",
      `
      import assert from "node:assert/strict"
      const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
      const { MigrationRegistry } = await import("@ericsanchezok/synergy-harness/migration/registry")
      const { ToolRegistry } = await import("@ericsanchezok/synergy-harness/tool/registry")
      const { SessionPluginHooks } = await import("@ericsanchezok/synergy-harness/session/plugin-hooks")
      const { registerLibrary } = await import(${JSON.stringify(entry)})
      registerLibrary()
      registerLibrary()
      assert.equal(MigrationRegistry.list().has("library"), true)
      assert.equal(ToolRegistry.toolProviderIDs().filter(id => id === "library").length, 1)
      for (const key of ["channel", "plugin", "voice", "mcp"]) assert.equal(key in Config.Info.shape, false)
      const initial = { results: ["unchanged"] }
      assert.equal(await SessionPluginHooks.trigger("library.search.after", {}, initial), initial)
      assert.deepEqual(await SessionPluginHooks.installed(), [])
    `,
    ],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(code, stderr).toBe(0)
})

test("Library disposal closes its database after operations and can repeat", async () => {
  const { registerLibrary, disposeLibrary } = await import("../src/register")
  const { LibraryDB } = await import("../src/database")
  registerLibrary()
  const connection = LibraryDB.connection()
  expect(connection.query("SELECT 1 AS value").get()).toEqual({ value: 1 })
  await disposeLibrary()
  expect(() => connection.query("SELECT 1").get()).toThrow()
  await disposeLibrary()
})

test("late Library import cannot partially register config or change dormant data", async () => {
  const { createIsolatedTestEnv } = await import("@ericsanchezok/synergy-testing/env")
  const isolated = await createIsolatedTestEnv()
  const entry = new URL("../src/register.ts", import.meta.url).pathname
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--eval",
      `
      import assert from "node:assert/strict"
      import path from "node:path"
      import fs from "node:fs/promises"
      const { Global } = await import("@ericsanchezok/synergy-harness/global")
      const { Config } = await import("@ericsanchezok/synergy-harness/config/config")
      const { ConfigDomain } = await import("@ericsanchezok/synergy-harness/config/domain")
      const { MigrationRegistry } = await import("@ericsanchezok/synergy-harness/migration/registry")
      const { RuntimeHandle } = await import("@ericsanchezok/synergy-harness/lifecycle")
      const configFile = path.join(Global.Path.config, "config/50-library.jsonc")
      const dataFile = path.join(Global.Path.data, "library/absent-owner.json")
      const dormant = JSON.stringify({ futureOwnerField: { revision: 42 } })
      for (const file of [configFile, dataFile]) {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, dormant)
      }
      const runtime = await RuntimeHandle.open({ mode: "oneshot" })
      try {
        assert.equal("library" in Config.Info.shape, false)
        await assert.rejects(import(${JSON.stringify(entry)}), /before opening the runtime/)
        for (const field of ["library", "embedding", "rerank"]) assert.equal(field in Config.Info.shape, false)
        assert.equal(ConfigDomain.byId.has("library"), false)
        assert.equal(MigrationRegistry.list().has("library"), false)
        for (const file of [configFile, dataFile]) assert.equal(await Bun.file(file).text(), dormant)
      } finally {
        await runtime.close()
      }
    `,
    ],
    env: {
      ...isolated.env,
      SYNERGY_OBSERVABILITY_INLINE: "1",
      SYNERGY_CONFIG_CONTENT: JSON.stringify({ execution: { agentWorkerMinIdle: 0 } }),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(code, stderr).toBe(0)
  } finally {
    await isolated.dispose()
  }
}, 30_000)
