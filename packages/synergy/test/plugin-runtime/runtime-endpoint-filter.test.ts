import { describe, expect, test } from "bun:test"
import path from "node:path"
import { compilePluginManifest } from "@ericsanchezok/synergy-plugin"
import { DEFAULT_LIMITS } from "../../src/plugin-runtime/health"
import { PluginRuntimeManager } from "../../src/plugin-runtime/manager"
import definition from "./fixtures/runtime-endpoint-filter"

describe("runtime endpoint capability filter", () => {
  test("exposes runtimeEndpoint only to contributions that require it", async () => {
    const manager = new PluginRuntimeManager()
    const entryPath = path.join(import.meta.dir, "fixtures", "runtime-endpoint-filter.ts")
    const manifest = compilePluginManifest(definition, {
      generation: "endpoint-filter-test",
      runtime: { entry: "runtime/index.js", sha256: "test" },
    })
    await manager.start({
      manifest,
      pluginDir: path.dirname(entryPath),
      entryPath,
      limits: { ...DEFAULT_LIMITS, startupTimeoutMs: 5_000 },
    })
    try {
      const declared = await manager.invoke({
        pluginId: manifest.id,
        handlerId: "operation:endpoint.declared",
        value: {},
        context: { scopeId: "scope", directory: import.meta.dir, actor: { type: "sdk" } },
        pluginDir: path.dirname(entryPath),
        manifest,
      })
      const undeclared = await manager.invoke({
        pluginId: manifest.id,
        handlerId: "operation:endpoint.undeclared",
        value: {},
        context: { scopeId: "scope", directory: import.meta.dir, actor: { type: "sdk" } },
        pluginDir: path.dirname(entryPath),
        manifest,
      })
      expect(declared).toEqual({ hasEndpoint: true })
      expect(undeclared).toEqual({ hasEndpoint: false })
    } finally {
      await manager.stop(manifest.id)
    }
  }, 15_000)
})
