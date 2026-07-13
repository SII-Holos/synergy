import { describe, expect, test } from "bun:test"
import { compilePluginManifest, definePlugin, lifecycleUninstall } from "@ericsanchezok/synergy-plugin"
import { runPluginUninstallLifecycle } from "../../src/plugin/install"
import type { LoadedPlugin } from "../../src/plugin/loader"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

const manifest = compilePluginManifest(
  definePlugin({
    id: "uninstall-test",
    version: "1.0.0",
    description: "Uninstall fixture",
    contributions: [lifecycleUninstall({ id: "cleanup", handler: async () => undefined })],
  }),
  {
    generation: "uninstall-generation",
    runtime: { entry: "runtime/index.js", sha256: "test" },
  },
)

const plugin = {
  id: manifest.id,
  name: manifest.name,
  manifest,
  pluginDir: "/plugin",
  source: "local",
  spec: "file:///plugin",
  enabledScopes: new Set<string>(),
  contributionHealth: new Map(),
} as LoadedPlugin

describe("plugin uninstall lifecycle", () => {
  test("stops normal uninstall on handler failure and force uninstall skips the handler", async () => {
    await using tmp = await tmpdir({ git: true })
    let ensured = 0
    let invoked = 0
    const services = {
      ensureRuntime: async () => {
        ensured++
      },
      invoke: async () => {
        invoked++
        throw new Error("cleanup failed")
      },
    }
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(runPluginUninstallLifecycle(plugin, false, services)).rejects.toThrow("cleanup failed")
      },
    })
    expect({ ensured, invoked }).toEqual({ ensured: 1, invoked: 1 })
    await runPluginUninstallLifecycle(plugin, true, services)
    expect({ ensured, invoked }).toEqual({ ensured: 1, invoked: 1 })
  })
})
