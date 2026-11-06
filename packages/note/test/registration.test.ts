import { expect, test } from "bun:test"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { SessionPluginHooks } from "@ericsanchezok/synergy-harness/session/plugin-hooks"
import { registerNote } from "../src/register"
import { testRuntime } from "./support/runtime"

test("note composes independently without product registration or plugin delivery", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    registerNote()
    registerNote()
    expect(MigrationRegistry.list().has("note")).toBe(true)
    expect(ToolRegistry.toolProviderIDs().filter((id) => id === "note")).toHaveLength(1)
    for (const key of ["channel", "plugin", "voice", "mcp"]) expect(key in Config.Info.shape).toBe(false)
    const initial = { results: ["unchanged"] }
    expect(await SessionPluginHooks.trigger("note.search.after", {}, initial)).toBe(initial)
    expect(await SessionPluginHooks.installed()).toEqual([])
  })
})
