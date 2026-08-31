import { describe, expect, test } from "bun:test"
import {
  compilePluginManifest,
  definePlugin,
  lifecycleInstall,
  lifecycleUninstall,
} from "@ericsanchezok/synergy-plugin"
import {
  clearThemePreferenceIfOwned,
  runPluginInstallLifecycle,
  runPluginUninstallLifecycle,
} from "../../src/plugin/install"
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

const installManifest = compilePluginManifest(
  definePlugin({
    id: "install-test",
    version: "1.0.0",
    description: "Install fixture",
    contributions: [lifecycleInstall({ id: "setup", handler: async () => undefined })],
  }),
  {
    generation: "install-generation",
    runtime: { entry: "runtime/index.js", sha256: "test" },
  },
)

const installPlugin = {
  ...plugin,
  id: installManifest.id,
  manifest: installManifest,
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

describe("plugin install lifecycle", () => {
  test("contains handler failures after installation instead of rolling back", async () => {
    await using tmp = await tmpdir({ git: true })
    let degraded = ""
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await expect(
          runPluginInstallLifecycle(installPlugin, {
            ensureRuntime: async () => undefined,
            invoke: async () => {
              throw new Error("installer launch failed")
            },
            onFailure: (_plugin, contribution, error) => {
              degraded = `${contribution.id}:${error instanceof Error ? error.message : String(error)}`
            },
          }),
        ).resolves.toEqual({ status: "failed", error: "installer launch failed" })
      },
    })
    expect(degraded).toBe("setup:installer launch failed")
  })
})

describe("theme preference cleanup on uninstall", () => {
  test("clears the preference when it names the removed plugin's skin", async () => {
    let cleared = 0
    const result = await clearThemePreferenceIfOwned("theme-plugin", {
      read: async () => ({ theme: "theme-plugin:skin" }),
      clear: async () => {
        cleared++
      },
    })
    expect(result).toBe(true)
    expect(cleared).toBe(1)
  })

  test("keeps the preference when it belongs to another theme or is unset", async () => {
    let cleared = 0
    const io = {
      clear: async () => {
        cleared++
      },
    }
    expect(
      await clearThemePreferenceIfOwned("theme-plugin", { ...io, read: async () => ({ theme: "other:skin" }) }),
    ).toBe(false)
    expect(await clearThemePreferenceIfOwned("theme-plugin", { ...io, read: async () => ({ theme: "" }) })).toBe(false)
    expect(await clearThemePreferenceIfOwned("theme-plugin", { ...io, read: async () => undefined })).toBe(false)
    expect(cleared).toBe(0)
  })
})
