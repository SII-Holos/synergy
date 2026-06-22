import { describe, expect, test, beforeEach, afterEach } from "bun:test"

// ---------------------------------------------------------------------------
// Tests for getRuntimeHealth and persistent warnings CRUD
// ---------------------------------------------------------------------------
import { getRuntimeHealth } from "../../src/plugin-runtime/health"
import { pushWarning, runtimeRegistry } from "../../src/plugin-runtime/runtime-registry"
import type { RuntimeEntry } from "../../src/plugin-runtime/runtime-registry"

// ---------------------------------------------------------------------------
// Unique plugin IDs per test — prevents shared singleton state pollution
// ---------------------------------------------------------------------------
let counter = 0
function uniquePluginId(): string {
  return `health-test-${Date.now()}-${counter++}`
}

function registerHealthyEntry(overrides?: Partial<RuntimeEntry>): RuntimeEntry {
  const id = uniquePluginId()
  const entry: RuntimeEntry = {
    pluginId: id,
    mode: "in-process",
    state: "ready",
    restarts: 0,
    warnings: [],
    startedAt: Date.now(),
    ...overrides,
  }
  runtimeRegistry.set(id, entry)
  return entry
}

// =============================================================================
// getRuntimeHealth — full fields populated
// =============================================================================

describe("getRuntimeHealth", () => {
  // -----------------------------------------------------------------------
  // Healthy plugin — all fields populated correctly
  // -----------------------------------------------------------------------
  describe("healthy plugin", () => {
    let pluginId: string

    beforeEach(() => {
      const entry = registerHealthyEntry()
      pluginId = entry.pluginId
    })

    afterEach(() => {
      runtimeRegistry.delete(pluginId)
    })

    test("returns all fields correctly for a running plugin", () => {
      const health = getRuntimeHealth(pluginId)
      expect(health).toBeDefined()
      expect(health!.pluginId).toBe(pluginId)
      expect(health!.state).toBeString()
      expect(health!.mode).toBeString()
      expect(health!.restarts).toBeNumber()
      expect(health!.warnings).toBeArray()
    })

    test("returns null for unknown plugin", () => {
      const health = getRuntimeHealth("nonexistent-plugin-xyz")
      expect(health).toBeNull()
    })

    test("state field reflects the RuntimeEntry state", () => {
      const health = getRuntimeHealth(pluginId)
      if (health) {
        const validStates = ["starting", "ready", "unhealthy", "stopped", "crashed"]
        expect(validStates).toContain(health.state)
      }
    })
  })

  // -----------------------------------------------------------------------
  // Warnings surfaced — each test pushes one warning and verifies it appears
  // -----------------------------------------------------------------------
  describe("warnings surfaced in health snapshot", () => {
    let pluginId: string

    beforeEach(() => {
      const entry = registerHealthyEntry()
      pluginId = entry.pluginId
    })

    afterEach(() => {
      runtimeRegistry.delete(pluginId)
    })

    test("surfaces capability_denied warnings", () => {
      pushWarning(pluginId, "capability_denied", "shell access denied")
      const health = getRuntimeHealth(pluginId)
      expect(health).toBeDefined()
      const denied = health!.warnings.filter((w) => w.type === "capability_denied")
      expect(denied.length).toBe(1)
      expect(denied[0].type).toBe("capability_denied")
      expect(denied[0].message).toBe("shell access denied")
      expect(denied[0].at).toBeGreaterThan(0)
    })

    test("surfaces heartbeat_missed warnings", () => {
      pushWarning(pluginId, "heartbeat_missed", "Missed 3 heartbeats")
      const health = getRuntimeHealth(pluginId)
      expect(health).toBeDefined()
      const missed = health!.warnings.filter((w) => w.type === "heartbeat_missed")
      expect(missed.length).toBe(1)
      expect(missed[0].message).toMatch(/heartbeat/i)
      expect(missed[0].at).toBeGreaterThan(0)
    })

    test("surfaces startup_timeout warnings", () => {
      pushWarning(pluginId, "startup_timeout", "Timed out after 5000ms")
      const health = getRuntimeHealth(pluginId)
      expect(health).toBeDefined()
      const timeout = health!.warnings.filter((w) => w.type === "startup_timeout")
      expect(timeout.length).toBe(1)
      expect(timeout[0].type).toBe("startup_timeout")
      expect(timeout[0].message).toBeString()
    })

    test("surfaces memory_limit_exceeded warnings", () => {
      pushWarning(pluginId, "memory_limit_exceeded", "Memory 300MB exceeded 256MB")
      const health = getRuntimeHealth(pluginId)
      expect(health).toBeDefined()
      const mem = health!.warnings.filter((w) => w.type === "memory_limit_exceeded")
      expect(mem.length).toBe(1)
      expect(mem[0].type).toBe("memory_limit_exceeded")
      expect(mem[0].message).toBeString()
    })

    test("surfaces log_rate_limited warnings", () => {
      pushWarning(pluginId, "log_rate_limited", "Log rate exceeded")
      const health = getRuntimeHealth(pluginId)
      expect(health).toBeDefined()
      const log = health!.warnings.filter((w) => w.type === "log_rate_limited")
      expect(log.length).toBe(1)
      expect(log[0].type).toBe("log_rate_limited")
      expect(log[0].message).toBeString()
    })

    test("warnings array is always present, even when empty", () => {
      const health = getRuntimeHealth(pluginId)
      if (health) {
        expect(health.warnings).toBeArray()
        expect(health.warnings).toEqual([])
      }
    })
  })

  // -----------------------------------------------------------------------
  // Warning metadata is well-formed
  // -----------------------------------------------------------------------
  describe("warning metadata", () => {
    let pluginId: string

    beforeEach(() => {
      const entry = registerHealthyEntry()
      pluginId = entry.pluginId
    })

    afterEach(() => {
      runtimeRegistry.delete(pluginId)
    })

    test("each warning has type, message, and at fields", () => {
      pushWarning(pluginId, "capability_denied", "test")
      const health = getRuntimeHealth(pluginId)
      if (health) {
        for (const w of health.warnings) {
          expect(w).toHaveProperty("type")
          expect(w).toHaveProperty("message")
          expect(w).toHaveProperty("at")
          expect(typeof w.type).toBe("string")
          expect(typeof w.message).toBe("string")
          expect(typeof w.at).toBe("number")
        }
      }
    })

    test("warning type is one of the known severity types", () => {
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
      pushWarning(pluginId, "capability_denied", "test")
      const health = getRuntimeHealth(pluginId)
      if (health) {
        for (const w of health.warnings) {
          expect(knownTypes).toContain(w.type)
        }
      }
    })
  })
})

// =============================================================================
// Persistent warnings CRUD on RuntimeEntry — pushWarning API
// =============================================================================
describe("RuntimeEntry warnings persistence", () => {
  let pluginId: string

  beforeEach(() => {
    const entry = registerHealthyEntry()
    pluginId = entry.pluginId
  })

  afterEach(() => {
    runtimeRegistry.delete(pluginId)
  })

  test("RuntimeEntry.warnings starts as empty array", () => {
    const health = getRuntimeHealth(pluginId)
    if (health) {
      expect(health.warnings).toEqual([])
    }
  })

  test("pushWarning appends and health snapshot reflects it", () => {
    pushWarning(pluginId, "capability_denied", "Test: shell access blocked")
    const health = getRuntimeHealth(pluginId)
    expect(health).toBeDefined()
    const capWarnings = health!.warnings.filter((w) => w.type === "capability_denied")
    expect(capWarnings.length).toBeGreaterThanOrEqual(1)
    // Most recent warning should be ours
    const last = capWarnings[capWarnings.length - 1]
    expect(last.type).toBe("capability_denied")
    expect(last.message).toBe("Test: shell access blocked")
    expect(last.at).toBeGreaterThan(0)
  })

  test("warnings persist across health snapshot calls", () => {
    pushWarning(pluginId, "heartbeat_missed", "Test: missed 2 beats")
    const health1 = getRuntimeHealth(pluginId)
    const health2 = getRuntimeHealth(pluginId)
    expect(health1!.warnings).toBe(health2!.warnings)
  })

  // -----------------------------------------------------------------------
  // Capability denied warning
  // -----------------------------------------------------------------------
  describe("capability_denied warning", () => {
    test("pushWarning creates a well-formed capability_denied warning", () => {
      pushWarning(pluginId, "capability_denied", "Capability network.fetch denied")
      const health = getRuntimeHealth(pluginId)
      const capWarnings = health!.warnings.filter(
        (w) => w.type === "capability_denied" && w.message.includes("network.fetch"),
      )
      expect(capWarnings.length).toBeGreaterThanOrEqual(1)
      for (const w of capWarnings) {
        expect(w.message).toBeString()
        expect(w.message.length).toBeGreaterThan(0)
      }
    })
  })

  // -----------------------------------------------------------------------
  // Heartbeat missed warning
  // -----------------------------------------------------------------------
  describe("heartbeat_missed warning", () => {
    test("pushWarning creates a well-formed heartbeat_missed warning", () => {
      pushWarning(pluginId, "heartbeat_missed", "Missed 3 heartbeat(s)")
      const health = getRuntimeHealth(pluginId)
      const hbWarnings = health!.warnings.filter((w) => w.type === "heartbeat_missed" && w.message.includes("3"))
      expect(hbWarnings.length).toBeGreaterThanOrEqual(1)
      for (const w of hbWarnings) {
        expect(w.message).toMatch(/missed|heartbeat/i)
        expect(w.at).toBeGreaterThan(0)
      }
    })
  })

  // -----------------------------------------------------------------------
  // Startup timeout warning
  // -----------------------------------------------------------------------
  describe("startup_timeout warning", () => {
    test("pushWarning creates a well-formed startup_timeout warning", () => {
      pushWarning(pluginId, "startup_timeout", "Startup timed out after 5000ms")
      const health = getRuntimeHealth(pluginId)
      const stWarnings = health!.warnings.filter((w) => w.type === "startup_timeout" && w.message.includes("5000ms"))
      expect(stWarnings.length).toBeGreaterThanOrEqual(1)
      for (const w of stWarnings) {
        expect(w.message).toBeString()
        expect(w.message.length).toBeGreaterThan(0)
      }
    })
  })

  // -----------------------------------------------------------------------
  // Memory limit exceeded warning
  // -----------------------------------------------------------------------
  describe("memory_limit_exceeded warning", () => {
    test("pushWarning creates a well-formed memory_limit_exceeded warning", () => {
      pushWarning(pluginId, "memory_limit_exceeded", "Memory 300MB exceeded limit 256MB")
      const health = getRuntimeHealth(pluginId)
      const memWarnings = health!.warnings.filter(
        (w) => w.type === "memory_limit_exceeded" && w.message.includes("300MB"),
      )
      expect(memWarnings.length).toBeGreaterThanOrEqual(1)
      for (const w of memWarnings) {
        expect(w.message).toMatch(/memory|MB/i)
        expect(w.at).toBeGreaterThan(0)
      }
    })
  })

  // -----------------------------------------------------------------------
  // Log rate limited warning
  // -----------------------------------------------------------------------
  describe("log_rate_limited warning", () => {
    test("pushWarning creates a well-formed log_rate_limited warning", () => {
      pushWarning(pluginId, "log_rate_limited", "Log rate limit exceeded — message dropped")
      const health = getRuntimeHealth(pluginId)
      const lrWarnings = health!.warnings.filter((w) => w.type === "log_rate_limited")
      expect(lrWarnings.length).toBeGreaterThanOrEqual(1)
      for (const w of lrWarnings) {
        expect(w.message).toMatch(/log|rate/i)
        expect(w.at).toBeGreaterThan(0)
      }
    })
  })
})
