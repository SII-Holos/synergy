import { expect, test } from "bun:test"
import path from "node:path"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { SessionPluginHooks } from "@ericsanchezok/synergy-harness/session/plugin-hooks"
import { testRuntime as coreRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { registerLibrary, disposeLibrary } from "../src/register"
import { LibraryDB } from "../src/database"
import { testRuntime } from "./support/runtime"

test("library composes independently without product registration or plugin delivery", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    registerLibrary()
    registerLibrary()
    expect(MigrationRegistry.list().has("library")).toBe(true)
    expect(ToolRegistry.toolProviderIDs().filter((id) => id === "library")).toHaveLength(1)
    for (const key of ["channel", "plugin", "voice", "mcp"]) expect(key in Config.Info.shape).toBe(false)
    const initial = { results: ["unchanged"] }
    expect(await SessionPluginHooks.trigger("library.search.after", {}, initial)).toBe(initial)
    expect(await SessionPluginHooks.installed()).toEqual([])
  })
})

test("Library disposal closes its database after operations and can repeat", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const connection = LibraryDB.connection()
    expect(connection.query("SELECT 1 AS value").get()).toEqual({ value: 1 })
    await disposeLibrary()
    expect(() => connection.query("SELECT 1").get()).toThrow()
    await disposeLibrary()
  })
})

test("late Library registration cannot partially register config or change dormant data", async () => {
  await using fixture = await runtimeHome()
  const files = [
    path.join(fixture.host.root, "config/50-library.jsonc"),
    path.join(fixture.host.root, "data/library/absent-owner.json"),
  ]
  const dormant = JSON.stringify({ futureOwnerField: { revision: 42 } })
  for (const file of files) await Bun.write(file, dormant)
  await using runtime = await coreRuntime({ home: fixture.host.home, composition: { register() {} } })
  await runtime.run(async () => {
    expect("library" in Config.Info.shape).toBe(false)
    expect(registerLibrary).toThrow(/before opening/i)
    expect(registerLibrary).toThrow(/before opening/i)
    for (const field of ["library", "embedding", "rerank"]) expect(field in Config.Info.shape).toBe(false)
    expect(ConfigDomain.byId().has("library")).toBe(false)
    expect(MigrationRegistry.list().has("library")).toBe(false)
    for (const file of files) expect(await Bun.file(file).text()).toBe(dormant)
  })
})
