import { expect, test } from "bun:test"

test("note composes independently without product registration or plugin delivery", async () => {
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
      const { registerNote } = await import(${JSON.stringify(entry)})
      registerNote()
      registerNote()
      assert.equal(MigrationRegistry.list().has("note"), true)
      assert.equal(ToolRegistry.toolProviderIDs().filter(id => id === "note").length, 1)
      for (const key of ["channel", "plugin", "voice", "mcp"]) assert.equal(key in Config.Info.shape, false)
      const initial = { results: ["unchanged"] }
      assert.equal(await SessionPluginHooks.trigger("note.search.after", {}, initial), initial)
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
