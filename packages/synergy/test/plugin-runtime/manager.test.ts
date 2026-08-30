import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import {
  compilePluginManifest,
  PLUGIN_RUNTIME_PROTOCOL_VERSION as PUBLIC_PLUGIN_RUNTIME_PROTOCOL_VERSION,
} from "@ericsanchezok/synergy-plugin"
import definition from "./fixtures/runtime-plugin"
import upgradeDefinition from "./fixtures/upgrade-plugin-v2"
import { PluginRuntimeError, PluginRuntimeManager } from "../../src/plugin-runtime/manager"
import { DEFAULT_LIMITS } from "../../src/plugin-runtime/health"
import { pluginAgentCallRuntime } from "../../src/plugin-runtime/agent-call-runtime"
import { PLUGIN_RUNTIME_PROTOCOL_VERSION } from "../../src/plugin-runtime/protocol"

describe("PluginRuntimeManager", () => {
  test("keeps the public diagnostic protocol version aligned with the host", () => {
    expect(PUBLIC_PLUGIN_RUNTIME_PROTOCOL_VERSION).toBe(PLUGIN_RUNTIME_PROTOCOL_VERSION)
  })

  test("deduplicates concurrent starts for the same plugin generation", async () => {
    const manager = new PluginRuntimeManager()
    const entryPath = path.join(import.meta.dir, "fixtures", "runtime-plugin.ts")
    const manifest = compilePluginManifest(definition, {
      generation: "concurrent-start",
      runtime: { entry: "runtime/index.js", sha256: "test" },
    })
    const input = { manifest, pluginDir: path.dirname(entryPath), entryPath }

    const entries = await Promise.all(Array.from({ length: 9 }, () => manager.start(input)))
    try {
      expect(new Set(entries)).toHaveLength(1)
      expect(new Set(entries.map((entry) => entry.process?.process.pid))).toHaveLength(1)
      expect(manager.registry.list()).toHaveLength(1)
      expect(manager.resourceStats().processCount).toBe(1)
    } finally {
      await manager.stop(manifest.id)
    }
  })

  test("allows a retry after a failed deduplicated start", async () => {
    const manager = new PluginRuntimeManager()
    const entryPath = path.join(import.meta.dir, "fixtures", "runtime-plugin.ts")
    const manifest = compilePluginManifest(definition, {
      generation: "concurrent-start-retry",
      runtime: { entry: "runtime/index.js", sha256: "test" },
    })

    await expect(
      Promise.all(
        Array.from({ length: 2 }, () =>
          manager.start({ manifest, pluginDir: path.dirname(entryPath), entryPath: `${entryPath}.missing` }),
        ),
      ),
    ).rejects.toThrow()

    const entry = await manager.start({ manifest, pluginDir: path.dirname(entryPath), entryPath })
    try {
      expect(entry.state).toBe("ready")
      expect(manager.registry.list()).toHaveLength(1)
    } finally {
      await manager.stop(manifest.id)
    }
  })

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

  test("waits for cancelled Agent call delivery before stopping a generation", async () => {
    const manager = new PluginRuntimeManager()
    const entryPath = path.join(import.meta.dir, "fixtures", "runtime-plugin.ts")
    const manifest = compilePluginManifest(definition, {
      generation: "stop-after-agent-cancellation",
      runtime: { entry: "runtime/index.js", sha256: "test" },
    })
    await manager.start({
      manifest,
      pluginDir: path.dirname(entryPath),
      entryPath,
    })

    let releaseCancellation!: () => void
    const cancellationDelivered = new Promise<void>((resolve) => {
      releaseCancellation = resolve
    })
    using _cancelGeneration = spyOn(pluginAgentCallRuntime, "cancelGeneration").mockImplementation(
      () => cancellationDelivered,
    )

    let stopped = false
    const stopping = manager.stop(manifest.id).then(() => {
      stopped = true
    })
    await Bun.sleep(1)
    expect(stopped).toBe(false)

    releaseCancellation()
    await stopping
    expect(stopped).toBe(true)
  })

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
          protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
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
          protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
        },
      })
      expect(manager.registry.active(manifest.id)?.mode).toBe("inProcess")
    } finally {
      await manager.stop(manifest.id)
    }
  })

  for (const mode of ["process", "inProcess"] as const) {
    test(`preserves structured log details in ${mode} mode`, async () => {
      const manager = new PluginRuntimeManager()
      const entryPath = path.join(import.meta.dir, "fixtures", "runtime-plugin.ts")
      const manifest = compilePluginManifest(definition, {
        generation: `log-details-${mode}`,
        runtime: { entry: "runtime/index.js", sha256: "test" },
      })
      await manager.start({
        manifest,
        pluginDir: path.dirname(entryPath),
        entryPath,
        mode,
        trustedBuiltin: mode === "inProcess",
      })
      try {
        await manager.invoke({
          pluginId: manifest.id,
          handlerId: "operation:log.details",
          value: {},
          context: { scopeId: "log-scope", directory: import.meta.dir, actor: { type: "sdk" } },
          pluginDir: path.dirname(entryPath),
          manifest,
        })
        await manager.invoke({
          pluginId: manifest.id,
          handlerId: "operation:log.message",
          value: {},
          context: { scopeId: "log-scope", directory: import.meta.dir, actor: { type: "sdk" } },
          pluginDir: path.dirname(entryPath),
          manifest,
        })
        expect(manager.logs.list(manifest.id)).toEqual([
          {
            timestamp: expect.any(Number),
            level: "error",
            message: "fixture failure",
            details: { code: "FIXTURE_ERROR", reason: "expected failure" },
          },
          {
            timestamp: expect.any(Number),
            level: "info",
            message: "fixture message",
            details: undefined,
          },
        ])
      } finally {
        await manager.stop(manifest.id)
      }
    })
  }

  test("preserves structured details for process runtime errors", async () => {
    const manager = new PluginRuntimeManager()
    const entryPath = path.join(import.meta.dir, "fixtures", "runtime-plugin.ts")
    const manifest = compilePluginManifest(definition, {
      generation: "runtime-error-details",
      runtime: { entry: "runtime/index.js", sha256: "test" },
    })
    await manager.start({ manifest, pluginDir: path.dirname(entryPath), entryPath })
    try {
      await expect(
        manager.invoke({
          pluginId: manifest.id,
          handlerId: "operation:runtime.error",
          value: {},
          context: { scopeId: "log-scope", directory: import.meta.dir, actor: { type: "sdk" } },
          pluginDir: path.dirname(entryPath),
          manifest,
        }),
      ).rejects.toMatchObject({ code: "RUNTIME_ERROR", message: "fixture runtime failure" })
      expect(manager.logs.list(manifest.id)).toEqual([
        {
          timestamp: expect.any(Number),
          level: "error",
          message: "fixture runtime failure",
          details: {
            name: "Error",
            code: "FIXTURE_RUNTIME_ERROR",
            reason: "fixture runtime failure",
          },
        },
      ])
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

  test("keeps an external runtime available after a timeout-shaped cancellation", async () => {
    const manager = new PluginRuntimeManager()
    const entryPath = path.join(import.meta.dir, "fixtures", "runtime-plugin.ts")
    const manifest = compilePluginManifest(definition, {
      generation: "external-timeout-cancellation",
      runtime: { entry: "runtime/index.js", sha256: "test" },
    })
    const controller = new AbortController()
    controller.abort(new DOMException("Caller timed out", "TimeoutError"))

    await manager.start({ manifest, pluginDir: path.dirname(entryPath), entryPath })
    try {
      await expect(
        manager.invoke({
          pluginId: manifest.id,
          handlerId: "operation:delay.get",
          value: { delayMs: 1_000 },
          context: { scopeId: "scope-one", directory: import.meta.dir, actor: { type: "sdk" } },
          pluginDir: path.dirname(entryPath),
          manifest,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "CANCELLED" })
      expect(manager.registry.active(manifest.id)?.state).toBe("ready")
    } finally {
      await manager.stop(manifest.id)
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
