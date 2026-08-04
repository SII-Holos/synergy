import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { compilePluginManifest } from "@ericsanchezok/synergy-plugin"
import definition from "./fixtures/runtime-plugin"
import { Config } from "../../src/config/config"
import { PluginRuntimeManager } from "../../src/plugin-runtime/manager"
import { ensureRuntime, type LoadedPlugin } from "../../src/plugin/loader"
import { pluginRuntimeManager } from "../../src/plugin/runtime"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

describe("plugin runtime configured limits wiring", () => {
  test("invoke fallback uses configured contributionInvokeTimeoutMs when no explicit timeout", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const entryPath = path.join(import.meta.dir, "fixtures", "runtime-plugin.ts")
    const manifest = compilePluginManifest(definition, {
      generation: "contribution-invoke-timeout",
      runtime: { entry: "runtime/index.js", sha256: "test" },
    })
    const manager = new PluginRuntimeManager()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await Config.state.reset()
        await Config.update({
          pluginRuntimePolicy: { limits: { contributionInvokeTimeoutMs: 100 } },
        } as any)
        await Config.state.reset()

        await manager.start({
          manifest,
          pluginDir: path.dirname(entryPath),
          entryPath,
        })
        try {
          await expect(
            manager.invoke({
              pluginId: manifest.id,
              handlerId: "operation:delay.get",
              value: { delayMs: 5_000 },
              context: { scopeId: scope.id, directory: import.meta.dir, actor: { type: "sdk" } },
              pluginDir: path.dirname(entryPath),
              manifest,
            }),
          ).rejects.toMatchObject({ code: "TIMEOUT" })
        } finally {
          await manager.stop(manifest.id, 0)
        }
      },
    })
  }, 15_000)

  test("ensureRuntime passes configured limits into pluginRuntimeManager.start", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const runtimePath = path.join(tmp.path, "runtime", "index.js")
    const plugin = {
      id: "limits-wiring-test",
      name: "limits-wiring-test",
      manifest: {
        artifacts: { runtime: { entry: "runtime/index.js" } },
        capabilities: [],
      },
      pluginDir: tmp.path,
      entryPath: runtimePath,
      source: "local",
      spec: "",
      enabledScopes: new Set<string>(),
      contributionHealth: new Map(),
    } as unknown as LoadedPlugin

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await Config.state.reset()
        await Config.update({
          pluginRuntimePolicy: {
            limits: {
              heartbeatIntervalMs: 1_234,
              maxMemoryMb: 99,
              hostServiceRequestTimeoutMs: 60_000,
            },
          },
        } as any)
        await Config.state.reset()

        const start = spyOn(pluginRuntimeManager, "start").mockImplementation(async () => {
          return { key: "limits-wiring-test" } as never
        })
        try {
          await ensureRuntime(plugin)
          expect(start).toHaveBeenCalledWith(
            expect.objectContaining({
              manifest: plugin.manifest,
              limits: expect.objectContaining({
                heartbeatIntervalMs: 1_234,
                maxMemoryMb: 99,
                hostServiceRequestTimeoutMs: 60_000,
              }),
            }),
          )
        } finally {
          start.mockRestore()
        }
      },
    })
  })
})

describe("plugin runtime timeout fallback defaults", () => {
  test("invoke keeps the 120s default when no config is set", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const entryPath = path.join(import.meta.dir, "fixtures", "runtime-plugin.ts")
    const manifest = compilePluginManifest(definition, {
      generation: "contribution-invoke-default",
      runtime: { entry: "runtime/index.js", sha256: "test" },
    })
    const manager = new PluginRuntimeManager()
    await manager.start({
      manifest,
      pluginDir: path.dirname(entryPath),
      entryPath,
    })
    try {
      await ScopeContext.provide({
        scope,
        fn: async () => {
          await expect(
            manager.invoke({
              pluginId: manifest.id,
              handlerId: "operation:scope.get",
              value: {},
              context: { scopeId: scope.id, directory: import.meta.dir, actor: { type: "sdk" } },
              pluginDir: path.dirname(entryPath),
              manifest,
            }),
          ).resolves.toMatchObject({ scopeId: scope.id })
        },
      })
    } finally {
      await manager.stop(manifest.id)
    }
  }, 15_000)
})
