import { describe, expect, test } from "bun:test"
import path from "path"
import { compilePluginManifest } from "@ericsanchezok/synergy-plugin"
import definition from "./fixtures/runtime-plugin"
import upgradeDefinition from "./fixtures/upgrade-plugin-v2"
import { PluginRuntimeError, PluginRuntimeManager } from "../../src/plugin-runtime/manager"
import { DEFAULT_LIMITS } from "../../src/plugin-runtime/health"

describe("PluginRuntimeManager", () => {
  test("memory recycling is generation-safe and reports the reclaimed runtime", async () => {
    const monitors: Array<{
      pid: number
      onSample(currentMb: number): void
      onExceed(currentMb: number, maxMb: number): void
      stopped: boolean
    }> = []
    const manager = new PluginRuntimeManager(undefined, {
      startMemoryMonitor(input) {
        const monitor = {
          pid: input.pid,
          onSample: input.onSample,
          onExceed: input.onExceed,
          stopped: false,
        }
        monitors.push(monitor)
        return {
          stop() {
            monitor.stopped = true
          },
        }
      },
    })
    const entryPath = path.join(import.meta.dir, "fixtures", "runtime-plugin.ts")
    const firstManifest = compilePluginManifest(definition, {
      generation: "memory-one",
      runtime: { entry: "runtime/index.js", sha256: "test" },
    })
    const secondManifest = compilePluginManifest(definition, {
      generation: "memory-two",
      runtime: { entry: "runtime/index.js", sha256: "test" },
    })

    await manager.start({
      manifest: firstManifest,
      pluginDir: path.dirname(entryPath),
      entryPath,
      limits: { ...DEFAULT_LIMITS, maxMemoryMb: 64, memorySampleIntervalMs: 10 },
    })
    monitors[0].onSample(40)
    await manager.start({
      manifest: secondManifest,
      pluginDir: path.dirname(entryPath),
      entryPath,
      limits: { ...DEFAULT_LIMITS, maxMemoryMb: 64, memorySampleIntervalMs: 10 },
    })
    monitors[1].onSample(48)
    monitors[0].onExceed(80, 64)
    for (let i = 0; i < 20 && manager.registry.list().length > 1; i++) await Bun.sleep(1)

    expect(manager.registry.active(definition.id)?.generation).toBe("memory-two")
    expect(manager.resourceStats()).toMatchObject({
      processCount: 1,
      measuredProcessCount: 1,
      lastRecovery: undefined,
    })

    const previousPid = monitors[1].pid
    monitors[1].onExceed(80, 64)
    for (
      let i = 0;
      i < 100 && (monitors.length < 3 || manager.registry.active(definition.id)?.generation !== "memory-two");
      i++
    ) {
      await Bun.sleep(1)
    }

    expect(monitors[1].stopped).toBe(true)
    expect(monitors[2]?.pid).not.toBe(previousPid)
    expect(manager.registry.active(definition.id)?.generation).toBe("memory-two")
    expect(manager.resourceStats()).toMatchObject({
      processCount: 1,
      lastRecovery: {
        action: "recycle",
        reason: "memory_limit",
        beforeBytes: 80 * 1024 * 1024,
        afterBytes: 0,
      },
    })
    await manager.stop(definition.id)
  }, 15_000)

  test("activates once and injects scope for every invocation", async () => {
    const manager = new PluginRuntimeManager()
    const entryPath = path.join(import.meta.dir, "fixtures", "runtime-plugin.ts")
    const manifest = compilePluginManifest(definition, {
      generation: "manager-test",
      runtime: { entry: "runtime/index.js", sha256: "test" },
    })
    await manager.start({
      manifest,
      pluginDir: path.dirname(entryPath),
      entryPath,
      limits: { ...DEFAULT_LIMITS, startupTimeoutMs: 5_000 },
    })
    try {
      const first = await manager.invoke({
        pluginId: manifest.id,
        handlerId: "operation:scope.get",
        value: {},
        context: { scopeId: "scope-one", directory: import.meta.dir, actor: { type: "sdk" } },
        pluginDir: path.dirname(entryPath),
        manifest,
      })
      const second = await manager.invoke({
        pluginId: manifest.id,
        handlerId: "operation:scope.get",
        value: {},
        context: { scopeId: "scope-two", directory: import.meta.dir, actor: { type: "ui" } },
        pluginDir: path.dirname(entryPath),
        manifest,
      })
      expect(first).toMatchObject({
        scopeId: "scope-one",
        activations: 1,
        runtime: {
          pluginVersion: "1.0.0",
          pluginGeneration: "manager-test",
          protocolVersion: 7,
        },
      })
      expect(second).toMatchObject({ scopeId: "scope-two", activations: 1 })
      expect(manager.registry.list()).toHaveLength(1)
    } finally {
      await manager.stop(manifest.id)
    }
  }, 15_000)

  test("runs a trusted built-in in process with the same invocation context", async () => {
    const manager = new PluginRuntimeManager()
    const entryPath = path.join(import.meta.dir, "fixtures", "runtime-plugin.ts")
    const manifest = compilePluginManifest(definition, {
      generation: "in-process-test",
      runtime: { entry: "runtime/index.js", sha256: "test" },
    })
    await manager.start({
      manifest,
      pluginDir: path.dirname(entryPath),
      entryPath,
      mode: "inProcess",
      trustedBuiltin: true,
    })
    try {
      const result = await manager.invoke({
        pluginId: manifest.id,
        handlerId: "operation:scope.get",
        value: {},
        context: { scopeId: "builtin-scope", directory: import.meta.dir, actor: { type: "sdk" } },
        pluginDir: path.dirname(entryPath),
        manifest,
      })
      expect(result).toMatchObject({
        scopeId: "builtin-scope",
        activations: 1,
        runtime: {
          pluginVersion: "1.0.0",
          pluginGeneration: "in-process-test",
          protocolVersion: 7,
        },
      })
      expect(manager.registry.active(manifest.id)?.mode).toBe("inProcess")
    } finally {
      await manager.stop(manifest.id)
    }
  })

  test("rejects in-process execution for installed plugins", async () => {
    const manager = new PluginRuntimeManager()
    const entryPath = path.join(import.meta.dir, "fixtures", "runtime-plugin.ts")
    const manifest = compilePluginManifest(definition, {
      generation: "untrusted-in-process-test",
      runtime: { entry: "runtime/index.js", sha256: "test" },
    })
    await expect(
      manager.start({
        manifest,
        pluginDir: path.dirname(entryPath),
        entryPath,
        mode: "inProcess",
      }),
    ).rejects.toThrow("reserved for trusted built-in plugins")
  })

  test("rejects a late response after an atomic generation swap", async () => {
    const manager = new PluginRuntimeManager()
    const entryPath = path.join(import.meta.dir, "fixtures", "runtime-plugin.ts")
    const firstManifest = compilePluginManifest(definition, {
      generation: "stale-one",
      runtime: { entry: "runtime/index.js", sha256: "test" },
    })
    const secondManifest = compilePluginManifest(definition, {
      generation: "stale-two",
      runtime: { entry: "runtime/index.js", sha256: "test" },
    })
    await manager.start({ manifest: firstManifest, pluginDir: path.dirname(entryPath), entryPath })
    const pending = manager.invoke({
      pluginId: firstManifest.id,
      handlerId: "operation:delay.get",
      value: { delayMs: 1_000 },
      context: { scopeId: "scope-one", directory: import.meta.dir, actor: { type: "sdk" } },
      pluginDir: path.dirname(entryPath),
      manifest: firstManifest,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await manager.start({ manifest: secondManifest, pluginDir: path.dirname(entryPath), entryPath })
    try {
      await expect(pending).rejects.toMatchObject({ code: "STALE_GENERATION" })
      expect(manager.registry.active(definition.id)?.generation).toBe("stale-two")
    } finally {
      await manager.stop(definition.id)
    }
  })

  test("terminates an external runtime on timeout and contains a process crash", async () => {
    const manager = new PluginRuntimeManager()
    const entryPath = path.join(import.meta.dir, "fixtures", "runtime-plugin.ts")
    const manifest = compilePluginManifest(definition, {
      generation: "failure-isolation",
      runtime: { entry: "runtime/index.js", sha256: "test" },
    })
    await manager.start({ manifest, pluginDir: path.dirname(entryPath), entryPath })
    await expect(
      manager.invoke({
        pluginId: manifest.id,
        handlerId: "operation:delay.get",
        value: { delayMs: 1_000 },
        context: { scopeId: "scope-one", directory: import.meta.dir, actor: { type: "sdk" } },
        pluginDir: path.dirname(entryPath),
        manifest,
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" })
    expect(manager.registry.active(manifest.id)).toBeUndefined()

    await manager.start({ manifest, pluginDir: path.dirname(entryPath), entryPath })
    await expect(
      manager.invoke({
        pluginId: manifest.id,
        handlerId: "operation:runtime.crash",
        value: {},
        context: { scopeId: "scope-one", directory: import.meta.dir, actor: { type: "sdk" } },
        pluginDir: path.dirname(entryPath),
        manifest,
      }),
    ).rejects.toBeInstanceOf(PluginRuntimeError)
    expect(manager.registry.active(manifest.id)?.state).toBe("crashed")
    await manager.stop(manifest.id)
  }, 15_000)

  test("keeps the old active generation when a prepared upgrade migration fails", async () => {
    const manager = new PluginRuntimeManager()
    const oldEntryPath = path.join(import.meta.dir, "fixtures", "runtime-plugin.ts")
    const newEntryPath = path.join(import.meta.dir, "fixtures", "upgrade-plugin-v2.ts")
    const oldManifest = compilePluginManifest(definition, {
      generation: "upgrade-old",
      runtime: { entry: "runtime/index.js", sha256: "test" },
    })
    const newManifest = compilePluginManifest(upgradeDefinition, {
      generation: "upgrade-new",
      runtime: { entry: "runtime/index.js", sha256: "test" },
    })
    await manager.start({
      manifest: oldManifest,
      pluginDir: path.dirname(oldEntryPath),
      entryPath: oldEntryPath,
      mode: "inProcess",
      trustedBuiltin: true,
    })
    const prepared = await manager.start({
      manifest: newManifest,
      pluginDir: path.dirname(newEntryPath),
      entryPath: newEntryPath,
      activate: false,
      mode: "inProcess",
      trustedBuiltin: true,
    })
    await expect(
      manager.invoke({
        pluginId: newManifest.id,
        handlerId: "lifecycle.upgrade:migrate",
        value: { fromVersion: "1.0.0", toVersion: "2.0.0" },
        context: { scopeId: "scope-one", directory: import.meta.dir, actor: { type: "lifecycle" } },
        pluginDir: path.dirname(newEntryPath),
        manifest: newManifest,
        runtimeKey: prepared.key,
      }),
    ).rejects.toThrow("migration failed")
    await manager.stopGeneration(prepared.key)
    expect(manager.registry.active(definition.id)?.version).toBe("1.0.0")
    await manager.stop(definition.id)
  }, 15_000)
})
