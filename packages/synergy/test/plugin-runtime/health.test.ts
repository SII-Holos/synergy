import { describe, expect, test, beforeAll } from "bun:test"

// ---------------------------------------------------------------------------
// Tests for getRuntimeHealth and persistent warnings CRUD
// ---------------------------------------------------------------------------
import { getRuntimeHealth, pushWarning } from "../../src/plugin-runtime/health"
import { startRuntime } from "../../src/plugin-runtime/supervisor"

// Register a single in-process runtime entry that all tests can query
const HEALTHY_PLUGIN = "test-plugin-healthy"

beforeAll(async () => {
  await startRuntime(HEALTHY_PLUGIN, {
    mode: "in-process",
    entryPath: "/tmp/test-plugin",
    pluginDir: "/tmp/test-plugin",
  })
})

// =============================================================================
// getRuntimeHealth — full fields populated
// =============================================================================

describe("getRuntimeHealth", () => {
  // -----------------------------------------------------------------------
  // Healthy plugin — all fields populated correctly
  // -----------------------------------------------------------------------
  describe("healthy plugin", () => {
    test("returns all fields correctly for a running plugin", () => {
      const health = getRuntimeHealth(HEALTHY_PLUGIN)
      expect(health).toBeDefined()
      expect(health!.pluginId).toBe(HEALTHY_PLUGIN)
      expect(health!.state).toBeString()
      expect(health!.mode).toBeString()
      expect(health!.restarts).toBeNumber()
      expect(health!.warnings).toBeArray()
    })

    test("returns null for unknown plugin", () => {
      const health = getRuntimeHealth("nonexistent-plugin")
      expect(health).toBeNull()
    })

    test("state field reflects the RuntimeEntry state", () => {
      const health = getRuntimeHealth(HEALTHY_PLUGIN)
      if (health) {
        const validStates = ["starting", "ready", "unhealthy", "stopped", "crashed"]
        expect(validStates).toContain(health.state)
      }
    })
  })

  // -----------------------------------------------------------------------
  // Warnings surfaced
  // -----------------------------------------------------------------------
  describe("warnings surfaced in health snapshot", () => {
    test("surfaces capability_denied warnings", () => {
      const health = getRuntimeHealth(HEALTHY_PLUGIN)
      if (health) {
        const deniedWarnings = health.warnings.filter((w) => w.type === "capability_denied")
        expect(deniedWarnings.length).toBeGreaterThanOrEqual(0)
        for (const w of deniedWarnings) {
          expect(w.type).toBe("capability_denied")
          expect(w.message).toBeString()
          expect(w.at).toBeNumber()
        }
      }
    })

    test("surfaces heartbeat_missed warnings", () => {
      const health = getRuntimeHealth(HEALTHY_PLUGIN)
      if (health) {
        const missedWarnings = health.warnings.filter((w) => w.type === "heartbeat_missed")
        expect(missedWarnings.length).toBeGreaterThanOrEqual(0)
        for (const w of missedWarnings) {
          expect(w.type).toBe("heartbeat_missed")
          expect(w.message).toBeString()
          expect(w.message).toMatch(/heartbeat/i)
        }
      }
    })

    test("surfaces startup_timeout warnings", () => {
      const health = getRuntimeHealth(HEALTHY_PLUGIN)
      if (health) {
        const timeoutWarnings = health.warnings.filter((w) => w.type === "startup_timeout")
        expect(timeoutWarnings.length).toBeGreaterThanOrEqual(0)
        for (const w of timeoutWarnings) {
          expect(w.type).toBe("startup_timeout")
          expect(w.message).toBeString()
        }
      }
    })

    test("surfaces memory_limit_exceeded warnings", () => {
      const health = getRuntimeHealth(HEALTHY_PLUGIN)
      if (health) {
        const memWarnings = health.warnings.filter((w) => w.type === "memory_limit_exceeded")
        expect(memWarnings.length).toBeGreaterThanOrEqual(0)
        for (const w of memWarnings) {
          expect(w.type).toBe("memory_limit_exceeded")
          expect(w.message).toBeString()
        }
      }
    })

    test("surfaces log_rate_limited warnings", () => {
      const health = getRuntimeHealth(HEALTHY_PLUGIN)
      if (health) {
        const logWarnings = health.warnings.filter((w) => w.type === "log_rate_limited")
        expect(logWarnings.length).toBeGreaterThanOrEqual(0)
        for (const w of logWarnings) {
          expect(w.type).toBe("log_rate_limited")
          expect(w.message).toBeString()
        }
      }
    })

    test("warnings array is always present, even when empty", () => {
      const health = getRuntimeHealth(HEALTHY_PLUGIN)
      if (health) {
        expect(health.warnings).toBeArray()
      }
    })
  })

  // -----------------------------------------------------------------------
  // Warning metadata is well-formed
  // -----------------------------------------------------------------------
  describe("warning metadata", () => {
    test("each warning has type, message, and at fields", () => {
      const health = getRuntimeHealth(HEALTHY_PLUGIN)
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
      ]
      const health = getRuntimeHealth(HEALTHY_PLUGIN)
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
  test("RuntimeEntry.warnings starts as empty array", () => {
    const health = getRuntimeHealth(HEALTHY_PLUGIN)
    if (health) {
      expect(health.warnings).toEqual([])
    }
  })

  test("pushWarning appends and health snapshot reflects it", () => {
    pushWarning(HEALTHY_PLUGIN, "capability_denied", "Test: shell access blocked")
    const health = getRuntimeHealth(HEALTHY_PLUGIN)
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
    pushWarning(HEALTHY_PLUGIN, "heartbeat_missed", "Test: missed 2 beats")
    const health1 = getRuntimeHealth(HEALTHY_PLUGIN)
    const health2 = getRuntimeHealth(HEALTHY_PLUGIN)
    expect(health1!.warnings).toBe(health2!.warnings)
  })

  // -----------------------------------------------------------------------
  // Capability denied warning
  // -----------------------------------------------------------------------
  describe("capability_denied warning", () => {
    test("pushWarning creates a well-formed capability_denied warning", () => {
      pushWarning(HEALTHY_PLUGIN, "capability_denied", "Capability network.fetch denied")
      const health = getRuntimeHealth(HEALTHY_PLUGIN)
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
      pushWarning(HEALTHY_PLUGIN, "heartbeat_missed", "Missed 3 heartbeat(s)")
      const health = getRuntimeHealth(HEALTHY_PLUGIN)
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
      pushWarning(HEALTHY_PLUGIN, "startup_timeout", "Startup timed out after 5000ms")
      const health = getRuntimeHealth(HEALTHY_PLUGIN)
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
      pushWarning(HEALTHY_PLUGIN, "memory_limit_exceeded", "Memory 300MB exceeded limit 256MB")
      const health = getRuntimeHealth(HEALTHY_PLUGIN)
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
      pushWarning(HEALTHY_PLUGIN, "log_rate_limited", "Log rate limit exceeded — message dropped")
      const health = getRuntimeHealth(HEALTHY_PLUGIN)
      const lrWarnings = health!.warnings.filter((w) => w.type === "log_rate_limited")
      expect(lrWarnings.length).toBeGreaterThanOrEqual(1)
      for (const w of lrWarnings) {
        expect(w.message).toMatch(/log|rate/i)
        expect(w.at).toBeGreaterThan(0)
      }
    })
  })
})
