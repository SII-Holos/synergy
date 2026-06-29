import { describe, expect, test, mock } from "bun:test"

// ---------------------------------------------------------------------------
// Mock the plugin-runtime supervisor BEFORE any imports that use it.
// autoStartRuntime dynamically imports startRuntime from the supervisor.
// The mocked startRuntime is captured here so tests can control its behavior.
// ---------------------------------------------------------------------------

let mockStartRuntimeCalls: Array<{
  pluginId: string
  options: Record<string, unknown>
}> = []
let mockStartRuntimeError: Error | null = null

// Import the real module exports before mocking, so other test files
// that import supervisor get real implementations (not stubs).
// Only startRuntime is replaced with a spy that registers in the real registry
// (so health/supervisor tests can find entries).
const realSupervisor = await import("../../src/plugin-runtime/supervisor.js")
const { defaultRuntimeRegistry } = await import("../../src/plugin-runtime/registry.js")
const { DEFAULT_LIMITS } = await import("../../src/plugin-runtime/health.js")

mock.module("../../src/plugin-runtime/supervisor.js", () => {
  const { startRuntime: _realStart, ...rest } = realSupervisor
  return {
    ...rest,
    startRuntime: mock((pluginId: string, options: Record<string, unknown>) => {
      mockStartRuntimeCalls.push({ pluginId, options })
      if (mockStartRuntimeError) throw mockStartRuntimeError
      const entry = {
        pluginId,
        mode: options.mode ?? "process",
        entryPath: options.entryPath,
        pluginDir: options.pluginDir,
        source: options.source,
        state: "ready" as const,
        restarts: 0,
        limits: DEFAULT_LIMITS,
        warnings: [],
      }
      defaultRuntimeRegistry.set(entry as any)
      return entry
    }),
  }
})

// ---------------------------------------------------------------------------
// Import the function under test after the mock is in place.
// autoStartRuntime is a focused helper that will be exported from install.ts.
// ---------------------------------------------------------------------------

const { autoStartRuntime } = await import("../../src/plugin/install.js")

const log = await import("../../src/util/log.js")
log.Log.init({ print: false })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetMockState() {
  mockStartRuntimeCalls = []
  mockStartRuntimeError = null
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("autoStartRuntime", () => {
  test("process mode install calls startRuntime with correct pluginId and entryPath", async () => {
    resetMockState()

    await autoStartRuntime({
      pluginId: "test-plugin",
      mode: "process",
      entryPath: "/tmp/test-plugin/index.js",
      pluginDir: "/tmp/test-plugin",
      source: "local",
    })

    expect(mockStartRuntimeCalls).toHaveLength(1)
    expect(mockStartRuntimeCalls[0].pluginId).toBe("test-plugin")
    expect(mockStartRuntimeCalls[0].options.mode).toBe("process")
    expect(mockStartRuntimeCalls[0].options.entryPath).toBe("/tmp/test-plugin/index.js")
    expect(mockStartRuntimeCalls[0].options.pluginDir).toBe("/tmp/test-plugin")
  })

  test("worker mode install calls startRuntime with worker mode", async () => {
    resetMockState()

    await autoStartRuntime({
      pluginId: "worker-plugin",
      mode: "worker",
      entryPath: "/tmp/worker-plugin/index.js",
      pluginDir: "/tmp/worker-plugin",
      source: "local",
    })

    expect(mockStartRuntimeCalls).toHaveLength(1)
    expect(mockStartRuntimeCalls[0].pluginId).toBe("worker-plugin")
    expect(mockStartRuntimeCalls[0].options.mode).toBe("worker")
  })

  test("in-process mode install does NOT call startRuntime", async () => {
    resetMockState()

    await autoStartRuntime({
      pluginId: "inproc-plugin",
      mode: "in-process",
      entryPath: "/tmp/inproc-plugin/index.js",
      pluginDir: "/tmp/inproc-plugin",
      source: "local",
    })

    expect(mockStartRuntimeCalls).toHaveLength(0)
  })

  test("startRuntime failure does not throw — it returns false to signal warning", async () => {
    resetMockState()
    mockStartRuntimeError = new Error("spawn failed: port in use")

    const result = await autoStartRuntime({
      pluginId: "failing-plugin",
      mode: "process",
      entryPath: "/tmp/failing-plugin/index.js",
      pluginDir: "/tmp/failing-plugin",
      source: "local",
    })

    // The call should have been attempted
    expect(mockStartRuntimeCalls).toHaveLength(1)
    // The function returns false to indicate runtime start failed
    expect(result).toBe(false)
  })

  test("startRuntime success returns true", async () => {
    resetMockState()

    const result = await autoStartRuntime({
      pluginId: "ok-plugin",
      mode: "process",
      entryPath: "/tmp/ok-plugin/index.js",
      pluginDir: "/tmp/ok-plugin",
      source: "local",
    })

    expect(result).toBe(true)
  })
})
