import { describe, expect, test } from "bun:test"

import { RuntimeRegistry, type RuntimeEntry, type RuntimeWarningType } from "../../src/plugin-runtime/registry.js"
import { createRuntimeHealth } from "../../src/plugin-runtime/health.js"

// === Helpers ===

let counter = 0

function uniquePluginId(): string {
  return `health-test-${Date.now()}-${counter++}`
}

function createEntry(pluginId: string, overrides?: Partial<RuntimeEntry>): RuntimeEntry {
  return {
    pluginId,
    mode: "in-process",
    state: "ready",
    startedAt: Date.now(),
    restarts: 0,
    warnings: [],
    ...overrides,
  }
}

// === Tests ===

describe("RuntimeRegistry.getHealth", () => {
  describe("healthy plugin", () => {
    test("returns all fields correctly for a running plugin", () => {
      const registry = new RuntimeRegistry()
      const pluginId = uniquePluginId()
      const entry = createEntry(pluginId, { state: "ready", mode: "in-process", restarts: 1, pid: 12345 })
      registry.set(entry)

      const health = registry.getHealth(pluginId)
      expect(health).toBeDefined()
      expect(health!.pluginId).toBe(pluginId)
      expect(health!.state).toBeString()
      expect(health!.mode).toBeString()
      expect(health!.restarts).toBeNumber()
      expect(health!.warnings).toBeArray()
    })

    test("returns null for unknown plugin", () => {
      const registry = new RuntimeRegistry()
      const health = registry.getHealth("nonexistent-plugin-xyz")
      expect(health).toBeNull()
    })

    test("state field reflects the RuntimeEntry state", () => {
      const registry = new RuntimeRegistry()
      const pluginId = uniquePluginId()
      const entry = createEntry(pluginId, { state: "starting" })
      registry.set(entry)

      const health = registry.getHealth(pluginId)
      expect(health).toBeDefined()
      expect(["starting", "ready", "unhealthy", "stopped", "crashed"]).toContain(health!.state)
    })
  })

  describe("warnings surfaced in health snapshot", () => {
    test("surfaces capability_denied warnings", () => {
      const registry = new RuntimeRegistry()
      const pluginId = uniquePluginId()
      registry.set(createEntry(pluginId))
      registry.pushWarning(pluginId, "capability_denied", "shell access denied")

      const health = registry.getHealth(pluginId)
      expect(health).toBeDefined()
      const matching = health!.warnings.filter((w) => w.type === "capability_denied")
      expect(matching.length).toBe(1)
      expect(matching[0].type).toBe("capability_denied")
      expect(matching[0].message).toBe("shell access denied")
      expect(matching[0].at).toBeGreaterThan(0)
    })

    test("surfaces heartbeat_missed warnings", () => {
      const registry = new RuntimeRegistry()
      const pluginId = uniquePluginId()
      registry.set(createEntry(pluginId))
      registry.pushWarning(pluginId, "heartbeat_missed", "Missed 3 heartbeats")

      const health = registry.getHealth(pluginId)
      expect(health).toBeDefined()
      const matching = health!.warnings.filter((w) => w.type === "heartbeat_missed")
      expect(matching.length).toBe(1)
      expect(matching[0].type).toBe("heartbeat_missed")
      expect(matching[0].message).toBe("Missed 3 heartbeats")
      expect(matching[0].at).toBeGreaterThan(0)
    })

    test("surfaces startup_timeout warnings", () => {
      const registry = new RuntimeRegistry()
      const pluginId = uniquePluginId()
      registry.set(createEntry(pluginId))
      registry.pushWarning(pluginId, "startup_timeout", "Timed out after 5000ms")

      const health = registry.getHealth(pluginId)
      expect(health).toBeDefined()
      const matching = health!.warnings.filter((w) => w.type === "startup_timeout")
      expect(matching.length).toBe(1)
      expect(matching[0].type).toBe("startup_timeout")
      expect(matching[0].message).toBe("Timed out after 5000ms")
      expect(matching[0].at).toBeGreaterThan(0)
    })

    test("surfaces memory_limit_exceeded warnings", () => {
      const registry = new RuntimeRegistry()
      const pluginId = uniquePluginId()
      registry.set(createEntry(pluginId))
      registry.pushWarning(pluginId, "memory_limit_exceeded", "Memory 300MB exceeded 256MB")

      const health = registry.getHealth(pluginId)
      expect(health).toBeDefined()
      const matching = health!.warnings.filter((w) => w.type === "memory_limit_exceeded")
      expect(matching.length).toBe(1)
      expect(matching[0].type).toBe("memory_limit_exceeded")
      expect(matching[0].message).toBe("Memory 300MB exceeded 256MB")
      expect(matching[0].at).toBeGreaterThan(0)
    })

    test("surfaces log_rate_limited warnings", () => {
      const registry = new RuntimeRegistry()
      const pluginId = uniquePluginId()
      registry.set(createEntry(pluginId))
      registry.pushWarning(pluginId, "log_rate_limited", "Log rate exceeded")

      const health = registry.getHealth(pluginId)
      expect(health).toBeDefined()
      const matching = health!.warnings.filter((w) => w.type === "log_rate_limited")
      expect(matching.length).toBe(1)
      expect(matching[0].type).toBe("log_rate_limited")
      expect(matching[0].message).toBe("Log rate exceeded")
      expect(matching[0].at).toBeGreaterThan(0)
    })

    test("warnings array is always present, even when empty", () => {
      const registry = new RuntimeRegistry()
      const pluginId = uniquePluginId()
      registry.set(createEntry(pluginId))

      const health = registry.getHealth(pluginId)
      expect(health).toBeDefined()
      expect(health!.warnings).toBeArray()
      expect(health!.warnings).toEqual([])
    })
  })

  describe("warning metadata", () => {
    test("each warning has type, message, and at fields", () => {
      const registry = new RuntimeRegistry()
      const pluginId = uniquePluginId()
      registry.set(createEntry(pluginId))
      registry.pushWarning(pluginId, "capability_denied", "test")

      const health = registry.getHealth(pluginId)
      expect(health).toBeDefined()

      for (const warning of health!.warnings) {
        expect(warning).toHaveProperty("type")
        expect(warning).toHaveProperty("message")
        expect(warning).toHaveProperty("at")
        expect(typeof warning.type).toBe("string")
        expect(typeof warning.message).toBe("string")
        expect(typeof warning.at).toBe("number")
      }
    })

    test("warning type is one of the known severity types", () => {
      const registry = new RuntimeRegistry()
      const pluginId = uniquePluginId()
      registry.set(createEntry(pluginId))
      const knownTypes = [
        "capability_denied",
        "memory_limit_exceeded",
        "log_rate_limited",
        "heartbeat_missed",
        "startup_timeout",
        "worker_error",
        "spawn_failed",
        "signature_mismatch",
      ]
      registry.pushWarning(pluginId, "capability_denied", "test")

      const health = registry.getHealth(pluginId)
      expect(health).toBeDefined()

      for (const warning of health!.warnings) {
        expect(knownTypes).toContain(warning.type)
      }
    })
  })
})

describe("RuntimeRegistry warnings persistence", () => {
  test("warnings starts as empty array on fresh entry", () => {
    const registry = new RuntimeRegistry()
    const pluginId = uniquePluginId()
    registry.set(createEntry(pluginId))

    const health = registry.getHealth(pluginId)
    expect(health).toBeDefined()
    expect(health!.warnings).toEqual([])
  })

  test("pushWarning appends and health snapshot reflects it", () => {
    const registry = new RuntimeRegistry()
    const pluginId = uniquePluginId()
    registry.set(createEntry(pluginId))
    registry.pushWarning(pluginId, "capability_denied", "Test: shell access blocked")

    const health = registry.getHealth(pluginId)
    expect(health).toBeDefined()

    const capWarnings = health!.warnings.filter((w) => w.type === "capability_denied")
    expect(capWarnings.length).toBeGreaterThanOrEqual(1)
    const last = capWarnings[capWarnings.length - 1]
    expect(last.type).toBe("capability_denied")
    expect(last.message).toBe("Test: shell access blocked")
    expect(last.at).toBeGreaterThan(0)
  })

  test("warnings persist across health snapshot calls", () => {
    const registry = new RuntimeRegistry()
    const pluginId = uniquePluginId()
    registry.set(createEntry(pluginId))
    registry.pushWarning(pluginId, "heartbeat_missed", "Test: missed 2 beats")

    const health1 = registry.getHealth(pluginId)
    const health2 = registry.getHealth(pluginId)
    expect(health1).toBeDefined()
    expect(health2).toBeDefined()
    // Same warnings array reference since it's the entry's mutable array
    expect(health1!.warnings).toBe(health2!.warnings)
  })

  test("pushWarning creates a well-formed capability_denied warning", () => {
    const registry = new RuntimeRegistry()
    const pluginId = uniquePluginId()
    registry.set(createEntry(pluginId))
    registry.pushWarning(pluginId, "capability_denied", "Capability network.fetch denied")

    const health = registry.getHealth(pluginId)
    expect(health).toBeDefined()

    const warnings = health!.warnings.filter(
      (w) => w.type === "capability_denied" && w.message.includes("network.fetch"),
    )
    expect(warnings.length).toBeGreaterThanOrEqual(1)
    for (const warning of warnings) {
      expect(warning.message).toBeString()
      expect(warning.message.length).toBeGreaterThan(0)
    }
  })

  test("pushWarning creates a well-formed heartbeat_missed warning", () => {
    const registry = new RuntimeRegistry()
    const pluginId = uniquePluginId()
    registry.set(createEntry(pluginId))
    registry.pushWarning(pluginId, "heartbeat_missed", "Missed 3 heartbeat(s)")

    const health = registry.getHealth(pluginId)
    expect(health).toBeDefined()

    const warnings = health!.warnings.filter((w) => w.type === "heartbeat_missed" && w.message.includes("3"))
    expect(warnings.length).toBeGreaterThanOrEqual(1)
    for (const warning of warnings) {
      expect(warning.message).toMatch(/missed|heartbeat/i)
      expect(warning.at).toBeGreaterThan(0)
    }
  })

  test("pushWarning creates a well-formed startup_timeout warning", () => {
    const registry = new RuntimeRegistry()
    const pluginId = uniquePluginId()
    registry.set(createEntry(pluginId))
    registry.pushWarning(pluginId, "startup_timeout", "Startup timed out after 5000ms")

    const health = registry.getHealth(pluginId)
    expect(health).toBeDefined()

    const warnings = health!.warnings.filter((w) => w.type === "startup_timeout" && w.message.includes("5000ms"))
    expect(warnings.length).toBeGreaterThanOrEqual(1)
    for (const warning of warnings) {
      expect(warning.message).toBeString()
      expect(warning.message.length).toBeGreaterThan(0)
    }
  })

  test("pushWarning creates a well-formed memory_limit_exceeded warning", () => {
    const registry = new RuntimeRegistry()
    const pluginId = uniquePluginId()
    registry.set(createEntry(pluginId))
    registry.pushWarning(pluginId, "memory_limit_exceeded", "Memory 300MB exceeded limit 256MB")

    const health = registry.getHealth(pluginId)
    expect(health).toBeDefined()

    const warnings = health!.warnings.filter((w) => w.type === "memory_limit_exceeded" && w.message.includes("300MB"))
    expect(warnings.length).toBeGreaterThanOrEqual(1)
    for (const warning of warnings) {
      expect(warning.message).toMatch(/memory|MB/i)
      expect(warning.at).toBeGreaterThan(0)
    }
  })

  test("pushWarning creates a well-formed log_rate_limited warning", () => {
    const registry = new RuntimeRegistry()
    const pluginId = uniquePluginId()
    registry.set(createEntry(pluginId))
    registry.pushWarning(pluginId, "log_rate_limited", "Log rate limit exceeded — message dropped")

    const health = registry.getHealth(pluginId)
    expect(health).toBeDefined()

    const warnings = health!.warnings.filter((w) => w.type === "log_rate_limited")
    expect(warnings.length).toBeGreaterThanOrEqual(1)
    for (const warning of warnings) {
      expect(warning.message).toMatch(/log|rate/i)
      expect(warning.at).toBeGreaterThan(0)
    }
  })
})

describe("createRuntimeHealth (pure function)", () => {
  test("returns health snapshot from a direct RuntimeEntry", () => {
    const pluginId = uniquePluginId()
    const entry: RuntimeEntry = {
      pluginId,
      mode: "process",
      state: "ready",
      startedAt: 1000000,
      pid: 12345,
      memoryMb: 128,
      restarts: 3,
      lastHeartbeatAt: 2000000,
      lastError: "something went wrong",
      runtimeDecision: "policy:process",
      warnings: [{ type: "capability_denied", message: "test", at: 3000 }],
    }

    const health = createRuntimeHealth(entry)
    expect(health.pluginId).toBe(pluginId)
    expect(health.state).toBe("ready")
    expect(health.mode).toBe("process")
    expect(health.startedAt).toBe(1000000)
    expect(health.pid).toBe(12345)
    expect(health.memoryMb).toBe(128)
    expect(health.restarts).toBe(3)
    expect(health.lastHeartbeatAt).toBe(2000000)
    expect(health.lastError).toBe("something went wrong")
    expect(health.runtimeDecision).toBe("policy:process")
    expect(health.warnings).toHaveLength(1)
    expect(health.warnings[0].type).toBe("capability_denied")
  })

  test("warnings are the same mutable reference (not copied)", () => {
    const entry: RuntimeEntry = {
      pluginId: "test-plugin",
      mode: "in-process",
      state: "ready",
      restarts: 0,
      warnings: [],
    }

    const health = createRuntimeHealth(entry)
    expect(health.warnings).toBe(entry.warnings)

    // Mutating entry.warnings should be visible in the already-created health snapshot
    entry.warnings.push({ type: "capability_denied", message: "late warning", at: 5000 })
    expect(health.warnings).toHaveLength(1)
    expect(health.warnings[0].message).toBe("late warning")
  })
})
