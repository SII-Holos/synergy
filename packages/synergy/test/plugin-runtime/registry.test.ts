import { describe, expect, test } from "bun:test"
import { RuntimeRegistry } from "../../src/plugin-runtime/registry.js"
import type { RuntimeEntry } from "../../src/plugin-runtime/registry.js"
import { DEFAULT_LIMITS } from "../../src/plugin-runtime/health.js"

// === Test helpers ===

function createEntry(pluginId: string, overrides?: Partial<RuntimeEntry>): RuntimeEntry {
  return {
    pluginId,
    mode: "in-process",
    state: "ready",
    restarts: 0,
    limits: DEFAULT_LIMITS,
    warnings: [],
    ...overrides,
  }
}

// === Tests ===

describe("RuntimeRegistry", () => {
  describe("set / get / has", () => {
    test("set stores an entry and get retrieves it", () => {
      const registry = new RuntimeRegistry()
      const entry = createEntry("plugin-a", { state: "ready", restarts: 1 })
      registry.set(entry)
      const fetched = registry.get("plugin-a")
      expect(fetched).toBeDefined()
      expect(fetched!.pluginId).toBe("plugin-a")
      expect(fetched!.state).toBe("ready")
      expect(fetched!.restarts).toBe(1)
    })

    test("set overwrites an existing entry by pluginId", () => {
      const registry = new RuntimeRegistry()
      registry.set(createEntry("plugin-a", { state: "starting" }))
      registry.set(createEntry("plugin-a", { state: "ready" }))
      const fetched = registry.get("plugin-a")
      expect(fetched!.state).toBe("ready")
    })

    test("get returns undefined for unknown pluginId", () => {
      const registry = new RuntimeRegistry()
      expect(registry.get("nonexistent")).toBeUndefined()
    })

    test("has returns true when entry is present", () => {
      const registry = new RuntimeRegistry()
      registry.set(createEntry("plugin-a"))
      expect(registry.has("plugin-a")).toBe(true)
    })

    test("has returns false when entry is absent", () => {
      const registry = new RuntimeRegistry()
      expect(registry.has("plugin-a")).toBe(false)
    })
  })

  describe("list", () => {
    test("list returns an empty array when no entries exist", () => {
      const registry = new RuntimeRegistry()
      expect(registry.list()).toEqual([])
    })

    test("list returns all stored entries", () => {
      const registry = new RuntimeRegistry()
      registry.set(createEntry("plugin-a"))
      registry.set(createEntry("plugin-b"))
      const list = registry.list()
      expect(list).toHaveLength(2)
      expect(list.map((e) => e.pluginId).sort()).toEqual(["plugin-a", "plugin-b"])
    })
  })

  describe("delete", () => {
    test("delete removes an entry by pluginId", () => {
      const registry = new RuntimeRegistry()
      registry.set(createEntry("plugin-a"))
      registry.delete("plugin-a")
      expect(registry.has("plugin-a")).toBe(false)
    })

    test("delete is a no-op for unknown pluginId", () => {
      const registry = new RuntimeRegistry()
      registry.delete("nonexistent")
      // Should not throw
    })
  })

  describe("clear", () => {
    test("clear removes all entries", () => {
      const registry = new RuntimeRegistry()
      registry.set(createEntry("plugin-a"))
      registry.set(createEntry("plugin-b"))
      registry.clear()
      expect(registry.list()).toEqual([])
    })
  })

  describe("update", () => {
    test("update applies updater to existing entry and returns it", () => {
      const registry = new RuntimeRegistry()
      registry.set(createEntry("plugin-a", { state: "starting", restarts: 0 }))
      const result = registry.update("plugin-a", (entry) => {
        entry.state = "ready"
        entry.restarts = 1
      })
      expect(result).toBeDefined()
      expect(result!.state).toBe("ready")
      expect(result!.restarts).toBe(1)
    })

    test("update returns the entry reference after mutation", () => {
      const registry = new RuntimeRegistry()
      registry.set(createEntry("plugin-a"))
      const result = registry.update("plugin-a", (entry) => {
        entry.lastHeartbeatAt = 1000
      })
      expect(result!.lastHeartbeatAt).toBe(1000)
    })

    test("update returns undefined for missing pluginId", () => {
      const registry = new RuntimeRegistry()
      const result = registry.update("nonexistent", (entry) => {
        entry.state = "ready"
      })
      expect(result).toBeUndefined()
    })

    test("update on missing pluginId does not throw", () => {
      const registry = new RuntimeRegistry()
      let called = false
      registry.update("nonexistent", () => {
        called = true
      })
      expect(called).toBe(false)
    })
  })

  describe("pushWarning", () => {
    test("pushWarning appends a warning to the entry", () => {
      const registry = new RuntimeRegistry()
      registry.set(createEntry("plugin-a", { warnings: [] }))
      registry.pushWarning("plugin-a", "capability_denied", "shell.run denied")
      const entry = registry.get("plugin-a")
      expect(entry!.warnings).toHaveLength(1)
      expect(entry!.warnings[0]).toMatchObject({
        type: "capability_denied",
        message: "shell.run denied",
      })
    })

    test("pushWarning sets at timestamp to the provided value", () => {
      const registry = new RuntimeRegistry()
      registry.set(createEntry("plugin-a", { warnings: [] }))
      registry.pushWarning("plugin-a", "heartbeat_missed", "missed heartbeat", 1234567890)
      expect(registry.get("plugin-a")!.warnings[0].at).toBe(1234567890)
    })

    test("pushWarning sets at timestamp to Date.now() when not provided", () => {
      const registry = new RuntimeRegistry()
      registry.set(createEntry("plugin-a", { warnings: [] }))
      const before = Date.now()
      registry.pushWarning("plugin-a", "startup_timeout", "timed out")
      const after = Date.now()
      const warningAt = registry.get("plugin-a")!.warnings[0].at
      expect(warningAt).toBeGreaterThanOrEqual(before)
      expect(warningAt).toBeLessThanOrEqual(after)
    })

    test("pushWarning is a no-op for unknown pluginId", () => {
      const registry = new RuntimeRegistry()
      registry.pushWarning("nonexistent", "capability_denied", "should not appear")
      // No throw, no side effects
    })

    test("pushWarning preserves existing warnings", () => {
      const registry = new RuntimeRegistry()
      registry.set(
        createEntry("plugin-a", {
          warnings: [{ type: "capability_denied" as const, message: "first", at: 1000 }],
        }),
      )
      registry.pushWarning("plugin-a", "heartbeat_missed", "second", 2000)
      const warnings = registry.get("plugin-a")!.warnings
      expect(warnings).toHaveLength(2)
      expect(warnings[0].message).toBe("first")
      expect(warnings[1].message).toBe("second")
    })
  })

  describe("getHealth", () => {
    test("getHealth returns a health snapshot for a known entry", () => {
      const registry = new RuntimeRegistry()
      const entry = createEntry("plugin-a", {
        mode: "process",
        state: "ready",
        pid: 12345,
        memoryMb: 128,
        restarts: 3,
        startedAt: 1000000,
        lastHeartbeatAt: 2000000,
        lastError: "something went wrong",
        runtimeDecision: "process",
        warnings: [{ type: "capability_denied" as const, message: "test", at: 3000 }],
      })
      registry.set(entry)
      const health = registry.getHealth("plugin-a")
      expect(health).not.toBeNull()
      expect(health!.pluginId).toBe("plugin-a")
      expect(health!.state).toBe("ready")
      expect(health!.mode).toBe("process")
      expect(health!.pid).toBe(12345)
      expect(health!.memoryMb).toBe(128)
      expect(health!.restarts).toBe(3)
      expect(health!.startedAt).toBe(1000000)
      expect(health!.lastHeartbeatAt).toBe(2000000)
      expect(health!.lastError).toBe("something went wrong")
      expect(health!.runtimeDecision).toBe("process")
    })

    test("getHealth returns null for unknown pluginId", () => {
      const registry = new RuntimeRegistry()
      expect(registry.getHealth("nonexistent")).toBeNull()
    })

    test("getHealth warnings array reflects current warnings", () => {
      const registry = new RuntimeRegistry()
      registry.set(createEntry("plugin-a", { warnings: [] }))
      registry.pushWarning("plugin-a", "capability_denied", "test")
      const health = registry.getHealth("plugin-a")
      expect(health!.warnings).toHaveLength(1)
      expect(health!.warnings[0].message).toBe("test")
    })
  })

  describe("snapshot / restore", () => {
    test("snapshot returns serializable fields only", () => {
      const registry = new RuntimeRegistry()
      registry.set(
        createEntry("plugin-a", {
          mode: "process",
          state: "ready",
          pid: 42,
          restarts: 1,
          startedAt: 1000,
          lastHeartbeatAt: 2000,
          lastError: "boom",
          // Non-serializable fields
          process: {} as unknown as Bun.Subprocess,
          worker: {} as unknown as any,
          concurrencyLimiter: {} as unknown as any,
          memoryMonitor: { stop: () => {} },
          logRateLimiter: {} as unknown as any,
          runtimeDecision: "process",
          memoryMb: 256,
          warnings: [{ type: "capability_denied" as const, message: "x", at: 1 }],
        }),
      )
      const snap = registry.snapshot()
      expect(snap).toHaveLength(1)
      const entry = snap[0]
      // Should contain persistable fields
      expect(entry.pluginId).toBe("plugin-a")
      expect(entry.mode).toBe("process")
      expect(entry.pid).toBe(42)
      expect(entry.state).toBe("ready")
      expect(entry.restarts).toBe(1)
      expect(entry.startedAt).toBe(1000)
      expect(entry.lastHeartbeatAt).toBe(2000)
      expect(entry.lastError).toBe("boom")
      // Should NOT contain non-persistable fields
      expect((entry as any).process).toBeUndefined()
      expect((entry as any).worker).toBeUndefined()
      expect((entry as any).concurrencyLimiter).toBeUndefined()
      expect((entry as any).memoryMonitor).toBeUndefined()
      expect((entry as any).logRateLimiter).toBeUndefined()
      expect((entry as any).runtimeDecision).toBeUndefined()
      expect((entry as any).memoryMb).toBeUndefined()
      expect((entry as any).warnings).toBeUndefined()
    })

    test("snapshot of empty registry returns empty array", () => {
      const registry = new RuntimeRegistry()
      expect(registry.snapshot()).toEqual([])
    })

    test("restore populates the registry from persisted entries", () => {
      const registry = new RuntimeRegistry()
      registry.restore([
        {
          pluginId: "plugin-a",
          mode: "process",
          state: "stopped",
          restarts: 2,
          startedAt: 5000,
        },
        {
          pluginId: "plugin-b",
          mode: "worker",
          state: "crashed",
          restarts: 0,
          lastError: "OOM",
        },
      ])
      expect(registry.has("plugin-a")).toBe(true)
      expect(registry.has("plugin-b")).toBe(true)
      const entryA = registry.get("plugin-a")!
      expect(entryA.mode).toBe("process")
      expect(entryA.state).toBe("stopped")
      expect(entryA.restarts).toBe(2)
      expect(entryA.startedAt).toBe(5000)
      expect(entryA.warnings).toEqual([])
      expect(entryA.process).toBeUndefined()
    })

    test("restore overwrites existing entries", () => {
      const registry = new RuntimeRegistry()
      registry.set(createEntry("plugin-a", { state: "ready", restarts: 0 }))
      registry.restore([{ pluginId: "plugin-a", mode: "process", state: "crashed", restarts: 5 }])
      const entry = registry.get("plugin-a")!
      expect(entry.state).toBe("crashed")
      expect(entry.restarts).toBe(5)
    })

    test("snapshot/restore roundtrip preserves data", () => {
      const registryA = new RuntimeRegistry()
      registryA.set(
        createEntry("plugin-a", {
          mode: "process",
          state: "ready",
          pid: 9999,
          restarts: 3,
          startedAt: 100,
          lastHeartbeatAt: 200,
          lastError: "oops",
          launchSignature: "manifest-entry-hash",
        }),
      )
      registryA.set(
        createEntry("plugin-b", {
          mode: "worker",
          state: "stopped",
          restarts: 0,
          startedAt: 300,
        }),
      )

      const snap = registryA.snapshot()

      const registryB = new RuntimeRegistry()
      registryB.restore(snap)

      expect(registryB.has("plugin-a")).toBe(true)
      expect(registryB.has("plugin-b")).toBe(true)
      const restoredA = registryB.get("plugin-a")!
      expect(restoredA.pluginId).toBe("plugin-a")
      expect(restoredA.mode).toBe("process")
      expect(restoredA.state).toBe("ready")
      expect(restoredA.pid).toBe(9999)
      expect(restoredA.restarts).toBe(3)
      expect(restoredA.startedAt).toBe(100)
      expect(restoredA.lastHeartbeatAt).toBe(200)
      expect(restoredA.lastError).toBe("oops")
      expect(restoredA.launchSignature).toBe("manifest-entry-hash")
      expect(restoredA.warnings).toEqual([])
    })
  })

  describe("isolation", () => {
    test("multiple RuntimeRegistry instances are independent", () => {
      const regA = new RuntimeRegistry()
      const regB = new RuntimeRegistry()

      regA.set(createEntry("plugin-a"))

      expect(regB.has("plugin-a")).toBe(false)

      regB.set(createEntry("plugin-b"))
      expect(regA.has("plugin-b")).toBe(false)
      expect(regB.has("plugin-b")).toBe(true)

      regA.clear()
      expect(regB.has("plugin-b")).toBe(true)
      expect(regA.has("plugin-a")).toBe(false)
    })

    test("defaultRuntimeRegistry is a real instance", () => {
      const { defaultRuntimeRegistry } = require("../../src/plugin-runtime/registry.js")
      // defaultRuntimeRegistry should be an instance of RuntimeRegistry
      expect(defaultRuntimeRegistry).toBeInstanceOf(RuntimeRegistry)
      // When empty, list returns an empty array
      // (Note: defaultRuntimeRegistry may have entries from other tests,
      // so we only assert the instance type)
    })
  })
})
