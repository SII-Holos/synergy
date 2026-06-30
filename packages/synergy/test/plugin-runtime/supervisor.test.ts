import { describe, expect, test } from "bun:test"
import {
  PluginRuntimeSupervisor,
  defaultPluginRuntimeSupervisor,
  resolveRuntimeLaunchMode,
} from "../../src/plugin-runtime/supervisor.js"
import { RuntimeRegistry } from "../../src/plugin-runtime/registry.js"
import { PluginLogBuffer } from "../../src/plugin-runtime/logs.js"
import { DEFAULT_LIMITS } from "../../src/plugin-runtime/health.js"
import type { RuntimeEntry } from "../../src/plugin-runtime/registry.js"
import type { RuntimeStatePersistence } from "../../src/plugin-runtime/supervisor.js"
import { DEFAULT_SERVER_URL } from "../../src/server/defaults.js"
import fs from "fs/promises"
import os from "os"
import path from "path"

// === Helpers ===

let counter = 0
const pluginDirs = new Map<string, string>()

function uniquePluginId(): string {
  return `sup-test-${Date.now()}-${counter++}`
}

async function pluginDirFor(pluginId: string): Promise<string> {
  const existing = pluginDirs.get(pluginId)
  if (existing) return existing

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${pluginId}-`))
  await Bun.write(
    path.join(dir, "plugin.json"),
    JSON.stringify(
      {
        name: pluginId,
        version: "1.0.0",
        description: "Supervisor test plugin",
        main: "./runtime/index.js",
      },
      null,
      2,
    ),
  )
  pluginDirs.set(pluginId, dir)
  return dir
}

function createSupervisor(opts?: { persist?: RuntimeStatePersistence }): {
  supervisor: PluginRuntimeSupervisor
  registry: RuntimeRegistry
  logs: PluginLogBuffer
} {
  const registry = new RuntimeRegistry()
  const logs = new PluginLogBuffer()
  const supervisor = new PluginRuntimeSupervisor({ registry, logs, persist: opts?.persist })
  return { supervisor, registry, logs }
}

async function startInProcess(
  supervisor: PluginRuntimeSupervisor,
  pluginId: string,
  overrides?: { entryPath?: string; pluginDir?: string },
): Promise<RuntimeEntry> {
  const pluginDir = overrides?.pluginDir ?? (await pluginDirFor(pluginId))
  return supervisor.start(pluginId, {
    mode: "in-process",
    entryPath: overrides?.entryPath ?? "",
    pluginDir,
    source: "local",
  })
}

// === Tests ===

describe("PluginRuntimeSupervisor", () => {
  describe("runtime launch mode", () => {
    test("keeps worker mode when the runner file is available", () => {
      expect(resolveRuntimeLaunchMode("worker", "policy:worker", true)).toEqual({
        mode: "worker",
        runtimeDecision: "policy:worker",
      })
    })

    test("falls back from worker to process when packaged without a runner file", () => {
      expect(resolveRuntimeLaunchMode("worker", "policy:worker", false)).toEqual({
        mode: "process",
        runtimeDecision: "policy:worker->process:packaged-runner",
      })
    })

    test("keeps process mode even when the worker runner is unavailable", () => {
      expect(resolveRuntimeLaunchMode("process", "policy:process", false)).toEqual({
        mode: "process",
        runtimeDecision: "policy:process",
      })
    })
  })

  describe("construction and dependencies", () => {
    test("constructs with injected registry, logs, and optional persist", () => {
      const { supervisor } = createSupervisor()
      expect(supervisor).toBeInstanceOf(PluginRuntimeSupervisor)
    })

    test("uses provided persist instead of default", async () => {
      let saved: RuntimeEntry[] = []
      const persist: RuntimeStatePersistence = {
        save: async (entries) => {
          saved = entries
        },
        load: async () => [],
      }
      const { supervisor } = createSupervisor({ persist })

      await startInProcess(supervisor, uniquePluginId())
      expect(saved.length).toBe(1)
      expect(saved[0].state).toBe("ready")
    })
  })

  describe("startRuntime", () => {
    test("registers in-process plugin and returns ready entry", async () => {
      const { supervisor, registry } = createSupervisor()
      const pluginId = uniquePluginId()

      const entry = await startInProcess(supervisor, pluginId)

      expect(entry.pluginId).toBe(pluginId)
      expect(entry.mode).toBe("in-process")
      expect(entry.state).toBe("ready")
      expect(entry.restarts).toBe(0)
      expect(entry.serverUrl).toBe(DEFAULT_SERVER_URL)
      expect(entry.warnings).toEqual([])
      expect(registry.get(pluginId)?.state).toBe("ready")
    })

    test("returns existing entry if already running", async () => {
      const { supervisor } = createSupervisor()
      const pluginId = uniquePluginId()

      const first = await startInProcess(supervisor, pluginId)
      const second = await startInProcess(supervisor, pluginId)

      // Should be the same entry reference
      expect(second).toBe(first)
      expect(second.launchSignature).toBe(first.launchSignature)
    })

    test("restarts when plugin manifest content changes even if paths stay the same", async () => {
      const { supervisor } = createSupervisor()
      const pluginId = uniquePluginId()
      const pluginDir = await pluginDirFor(pluginId)

      const first = await startInProcess(supervisor, pluginId, { pluginDir })
      await Bun.write(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify(
          {
            name: pluginId,
            version: "1.0.1",
            description: "Supervisor test plugin changed",
            main: "./runtime/index.js",
          },
          null,
          2,
        ),
      )

      const second = await startInProcess(supervisor, pluginId, { pluginDir })

      expect(second).not.toBe(first)
      expect(second.state).toBe("ready")
      expect(second.restarts).toBe(1)
      expect(second.launchSignature).not.toBe(first.launchSignature)
    })

    test("restarts when packaged integrity changes even if manifest and entry stay the same", async () => {
      const { supervisor } = createSupervisor()
      const pluginId = uniquePluginId()
      const pluginDir = await pluginDirFor(pluginId)

      await Bun.write(path.join(pluginDir, "integrity.json"), JSON.stringify({ files: { "assets/a.txt": "old" } }))
      const first = await startInProcess(supervisor, pluginId, { pluginDir })

      await Bun.write(path.join(pluginDir, "integrity.json"), JSON.stringify({ files: { "assets/a.txt": "new" } }))
      const second = await startInProcess(supervisor, pluginId, { pluginDir })

      expect(second).not.toBe(first)
      expect(second.state).toBe("ready")
      expect(second.restarts).toBe(1)
      expect(second.launchSignature).not.toBe(first.launchSignature)
    })

    test("restarts a running plugin when the launch spec changes", async () => {
      const { supervisor } = createSupervisor()
      const pluginId = uniquePluginId()

      const first = await startInProcess(supervisor, pluginId, { entryPath: "/tmp/plugin-a/index.js" })
      const second = await startInProcess(supervisor, pluginId, { entryPath: "/tmp/plugin-b/index.js" })

      expect(second).not.toBe(first)
      expect(second.entryPath).toBe("/tmp/plugin-b/index.js")
      expect(second.restarts).toBe(1)
      expect(second.state).toBe("ready")
    })

    test("increments restarts when re-starting a stopped plugin", async () => {
      const { supervisor } = createSupervisor()
      const pluginId = uniquePluginId()

      await startInProcess(supervisor, pluginId)
      await supervisor.stop(pluginId, false)

      const entry = await startInProcess(supervisor, pluginId)
      expect(entry.restarts).toBe(1)
    })

    test("increments restarts when re-starting a crashed plugin", async () => {
      const { supervisor, registry } = createSupervisor()
      const pluginId = uniquePluginId()

      // Manually create a crashed entry
      registry.set({
        pluginId,
        mode: "process",
        state: "crashed",
        restarts: 0,
        limits: DEFAULT_LIMITS,
        warnings: [],
      })

      const entry = await startInProcess(supervisor, pluginId)
      expect(entry.restarts).toBe(1)
    })

    test("preserves existing restarts count when re-registering running plugin", async () => {
      const { supervisor } = createSupervisor()
      const pluginId = uniquePluginId()

      const first = await startInProcess(supervisor, pluginId)
      first.restarts = 5
      const second = await startInProcess(supervisor, pluginId)

      expect(second.restarts).toBe(5)
    })
  })

  describe("stopRuntime", () => {
    test("marks entry as stopped", async () => {
      const { supervisor, registry } = createSupervisor()
      const pluginId = uniquePluginId()

      await startInProcess(supervisor, pluginId)
      await supervisor.stop(pluginId, false)

      const entry = registry.get(pluginId)
      expect(entry?.state).toBe("stopped")
    })

    test("is a no-op for unknown plugin", async () => {
      const { supervisor } = createSupervisor()
      // Should not throw
      await supervisor.stop("nonexistent-plugin", false)
    })

    test("is a no-op for already stopped plugin", async () => {
      const { supervisor } = createSupervisor()
      const pluginId = uniquePluginId()

      await startInProcess(supervisor, pluginId)
      await supervisor.stop(pluginId, false)
      // Second stop should not throw
      await supervisor.stop(pluginId, false)
    })
  })

  describe("killRuntime", () => {
    test("marks entry as stopped", async () => {
      const { supervisor, registry } = createSupervisor()
      const pluginId = uniquePluginId()

      await startInProcess(supervisor, pluginId)
      await supervisor.kill(pluginId)

      const entry = registry.get(pluginId)
      expect(entry?.state).toBe("stopped")
    })

    test("is a no-op for unknown plugin", async () => {
      const { supervisor } = createSupervisor()
      await supervisor.kill("nonexistent-plugin")
    })
  })

  describe("reloadRuntime", () => {
    test("reloads a running plugin", async () => {
      const { supervisor } = createSupervisor()
      const pluginId = uniquePluginId()

      await startInProcess(supervisor, pluginId)
      const entry = await supervisor.reload(pluginId)

      expect(entry.pluginId).toBe(pluginId)
      expect(entry.state).toBe("ready")
      expect(entry.restarts).toBe(1) // stop + start increments restarts
    })

    test("reuses the original runtime entry path and plugin directory", async () => {
      const { supervisor } = createSupervisor()
      const pluginId = uniquePluginId()
      const pluginDir = await pluginDirFor(pluginId)
      const entryPath = path.join(pluginDir, "dist/runtime.js")

      const first = await startInProcess(supervisor, pluginId, {
        entryPath,
        pluginDir,
      })
      expect(first.entryPath).toBe(entryPath)
      expect(first.pluginDir).toBe(pluginDir)

      const entry = await supervisor.reload(pluginId)

      expect(entry.entryPath).toBe(entryPath)
      expect(entry.pluginDir).toBe(pluginDir)
    })

    test("throws for unknown plugin", async () => {
      const { supervisor } = createSupervisor()
      await expect(supervisor.reload("nonexistent-plugin")).rejects.toThrow("Cannot reload unknown plugin")
    })
  })

  describe("query methods", () => {
    test("getRuntime returns entry for known plugin", async () => {
      const { supervisor } = createSupervisor()
      const pluginId = uniquePluginId()

      expect(supervisor.getRuntime(pluginId)).toBeUndefined()
      await startInProcess(supervisor, pluginId)
      expect(supervisor.getRuntime(pluginId)?.pluginId).toBe(pluginId)
    })

    test("getRuntime returns undefined for unknown plugin", () => {
      const { supervisor } = createSupervisor()
      expect(supervisor.getRuntime("unknown-plugin")).toBeUndefined()
    })

    test("getAllRuntimes returns all entries", async () => {
      const { supervisor } = createSupervisor()
      const a = uniquePluginId()
      const b = uniquePluginId()

      await startInProcess(supervisor, a)
      await startInProcess(supervisor, b)

      const all = supervisor.getAllRuntimes()
      expect(all).toHaveLength(2)
      expect(all.map((e) => e.pluginId)).toContain(a)
      expect(all.map((e) => e.pluginId)).toContain(b)
    })

    test("getRuntimeState returns state string", async () => {
      const { supervisor } = createSupervisor()
      const pluginId = uniquePluginId()

      expect(supervisor.getRuntimeState(pluginId)).toBe("stopped")
      await startInProcess(supervisor, pluginId)
      expect(supervisor.getRuntimeState(pluginId)).toBe("ready")
    })

    test("getRuntimeHealth returns health snapshot", async () => {
      const { supervisor } = createSupervisor()
      const pluginId = uniquePluginId()

      expect(supervisor.getRuntimeHealth(pluginId)).toBeNull()
      await startInProcess(supervisor, pluginId)

      const health = supervisor.getRuntimeHealth(pluginId)
      expect(health).toBeDefined()
      expect(health!.pluginId).toBe(pluginId)
      expect(health!.state).toBe("ready")
      expect(health!.mode).toBe("in-process")
      expect(health!.warnings).toEqual([])
    })

    test("getLogBuffer returns the injected log buffer", () => {
      const { supervisor, logs } = createSupervisor()
      expect(supervisor.getLogBuffer()).toBe(logs)
    })
  })

  describe("restoreRuntimeState", () => {
    test("restores entries from persistence", async () => {
      let loaded = false
      const persist: RuntimeStatePersistence = {
        save: async () => {},
        load: async () => {
          loaded = true
          return [
            {
              pluginId: "restored-plugin",
              mode: "process",
              state: "stopped",
              restarts: 0,
              startedAt: Date.now(),
            },
          ]
        },
      }
      const { supervisor, registry } = createSupervisor({ persist })

      await supervisor.restoreRuntimeState()

      expect(loaded).toBe(true)
      expect(registry.get("restored-plugin")?.pluginId).toBe("restored-plugin")
      expect(registry.get("restored-plugin")?.state).toBe("stopped")
    })

    test("is a no-op when persistence returns empty", async () => {
      const { supervisor } = createSupervisor()
      // Default persistence will try to read file — this should not throw
      await supervisor.restoreRuntimeState()
    })
  })

  describe("isolation", () => {
    test("two supervisors with different registries are independent", async () => {
      const supA = createSupervisor()
      const supB = createSupervisor()
      const pluginId = uniquePluginId()

      await startInProcess(supA.supervisor, pluginId)

      // Sup A should have it, Sup B should not
      expect(supA.supervisor.getRuntime(pluginId)).toBeDefined()
      expect(supB.supervisor.getRuntime(pluginId)).toBeUndefined()

      // Sup B's registry is independent
      expect(supB.registry.list()).toHaveLength(0)
    })
  })

  describe("defaultPluginRuntimeSupervisor", () => {
    test("defaultPluginRuntimeSupervisor is a PluginRuntimeSupervisor instance", () => {
      expect(defaultPluginRuntimeSupervisor).toBeInstanceOf(PluginRuntimeSupervisor)
    })
  })

  describe("facade exports", () => {
    test("facade functions delegate to defaultPluginRuntimeSupervisor", async () => {
      const {
        getRuntime,
        getAllRuntimes,
        getRuntimeState,
        getRuntimeHealth,
        getLogBuffer,
        startRuntime,
        stopRuntime,
        killRuntime,
        reloadRuntime,
        restoreRuntimeState,
      } = await import("../../src/plugin-runtime/supervisor.js")

      const pluginId = uniquePluginId()

      // Start via facade
      const pluginDir = await pluginDirFor(pluginId)
      const entry = await startRuntime(pluginId, {
        mode: "in-process",
        entryPath: "",
        pluginDir,
        source: "local",
      })

      expect(entry.state).toBe("ready")
      expect(getRuntime(pluginId)).toBeDefined()
      expect(getAllRuntimes().length).toBeGreaterThanOrEqual(1)
      expect(getRuntimeState(pluginId)).toBe("ready")
      expect(getRuntimeHealth(pluginId)?.pluginId).toBe(pluginId)
      expect(getLogBuffer()).toBeInstanceOf(PluginLogBuffer)

      await stopRuntime(pluginId, false)
      expect(getRuntimeState(pluginId)).toBe("stopped")

      await killRuntime(pluginId)
      expect(getRuntimeState(pluginId)).toBe("stopped")

      await reloadRuntime(pluginId)
      expect(getRuntimeState(pluginId)).toBe("ready")

      await restoreRuntimeState()
    })
  })
})
