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

mock.module("../../src/plugin-runtime/supervisor.js", () => ({
  startRuntime: mock((pluginId: string, options: Record<string, unknown>) => {
    mockStartRuntimeCalls.push({ pluginId, options })
    if (mockStartRuntimeError) throw mockStartRuntimeError
    return { pluginId, mode: options.mode ?? "process", state: "ready" }
  }),
  getRuntime: () => undefined,
  getAllRuntimes: () => [],
  getRuntimeState: () => "stopped",
  stopRuntime: () => Promise.resolve(),
  reloadRuntime: () => Promise.resolve({}),
  killRuntime: () => Promise.resolve(),
  restoreRuntimeState: () => Promise.resolve(),
}))

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
    })

    expect(result).toBe(true)
  })
})
