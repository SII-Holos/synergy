import { describe, expect, test, mock, afterEach, beforeEach } from "bun:test"
import { EventEmitter } from "events"
import type {
  PluginToHost,
  HostToPlugin,
  IsolatedPluginInputData,
  HostBridgeMethod,
} from "../../src/plugin-runtime/protocol"
import { spawnPluginWorker, setWorkerFactoryForTest } from "../../src/plugin-runtime/worker-host"
import type { SpawnedWorkerRuntime } from "../../src/plugin-runtime/worker-host"
import { DEFAULT_LIMITS } from "../../src/plugin-runtime/health"

// ---------------------------------------------------------------------------
// Mock node:worker_threads Worker
// ---------------------------------------------------------------------------
// Each test creates a MockWorker; the Worker constructor stores the instance
// so tests can emit events after spawnPluginWorker attaches its listeners.

let currentMockWorker: MockWorker | null = null

class MockWorker extends EventEmitter {
  threadId: number
  postMessage: ReturnType<typeof mock>
  terminate: ReturnType<typeof mock>
  readonly filename: string
  readonly workerData: { entryPath: string; input: IsolatedPluginInputData }

  constructor(filename: string, options?: { workerData?: { entryPath: string; input: IsolatedPluginInputData } }) {
    super()
    this.filename = filename
    this.workerData = options?.workerData ?? ({} as { entryPath: string; input: IsolatedPluginInputData })
    this.threadId = 99999
    this.postMessage = mock((_msg: unknown) => {})
    this.terminate = mock(() => {})
    currentMockWorker = this
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildInput(overrides: Partial<IsolatedPluginInputData> = {}): IsolatedPluginInputData {
  return {
    pluginId: "test-plugin",
    pluginDir: "/tmp/test-plugin",
    scope: {
      id: "test-scope",
      type: "project",
      directory: "/tmp/test-plugin",
      worktree: "/tmp/test-plugin",
      time: { created: 0, updated: 0 },
      sandboxes: [],
    },
    directory: "/tmp/test-plugin",
    serverUrl: "http://localhost:3000",
    runtimeLimits: DEFAULT_LIMITS,
    ...overrides,
  }
}

function readyMessage(overrides: Partial<Extract<PluginToHost, { type: "ready" }>> = {}): PluginToHost {
  return {
    type: "ready",
    tools: [{ id: "tool-1", description: "A test tool" }],
    hooks: ["beforeInvoke"],
    ...overrides,
  }
}

function heartbeatMessage(): PluginToHost {
  return { type: "heartbeat" }
}

function logMessage(level: "debug" | "info" | "warn" | "error" = "info", message = "test log"): PluginToHost {
  return { type: "log", level, message }
}

function hostRequestMessage(
  requestId = "req-1",
  method: HostBridgeMethod = "config.get",
  params: unknown = {},
): PluginToHost {
  return { type: "hostRequest", requestId, method: method as HostBridgeMethod, params }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("spawnPluginWorker", () => {
  beforeEach(() => {
    setWorkerFactoryForTest((filename, options) => new MockWorker(filename, options) as any)
  })

  afterEach(() => {
    currentMockWorker = null
    setWorkerFactoryForTest()
  })

  // -----------------------------------------------------------------------
  // Happy path: init → ready
  // -----------------------------------------------------------------------
  describe("happy path: init → ready", () => {
    test("spawns the Synergy plugin runtime runner", async () => {
      const input = buildInput()
      const runtime = await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/worker.js",
        input,
      })
      expect(currentMockWorker).not.toBeNull()
      expect(currentMockWorker!.filename).toContain("plugin-runtime/runner.ts")
    })

    test("passes plugin entryPath and input as workerData to the runner", async () => {
      const input = buildInput()
      await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/worker.js",
        input,
      })
      expect(currentMockWorker).not.toBeNull()
      expect(currentMockWorker!.workerData).toEqual({
        entryPath: "/tmp/test-plugin/worker.js",
        input,
      })
    })

    test("returns a SpawnedWorkerRuntime with all fields", async () => {
      const runtime = await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/worker.js",
        input: buildInput(),
      })
      expect(runtime.worker).toBeDefined()
      expect(runtime.onMessage).toBeFunction()
      expect(runtime.send).toBeFunction()
      expect(runtime.kill).toBeFunction()
      expect(runtime.state).toBeDefined()
      expect(runtime.state.ready).toBe(false)
    })

    test("sets state.ready and populates tools/hooks when worker emits ready", async () => {
      const runtime = await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/worker.js",
        input: buildInput(),
      })
      expect(runtime.state.ready).toBe(false)

      currentMockWorker!.emit(
        "message",
        readyMessage({ tools: [{ id: "t1", description: "Tool 1" }], hooks: ["hook-a"] }),
      )

      expect(runtime.state.ready).toBe(true)
      expect(runtime.state.tools).toEqual([{ id: "t1", description: "Tool 1" }])
      expect(runtime.state.hooks).toEqual(["hook-a"])
    })

    test("onMessage forwards messages to the registered handler", async () => {
      const runtime = await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/worker.js",
        input: buildInput(),
      })
      const handler = mock((_msg: PluginToHost) => {})
      runtime.onMessage(handler)

      currentMockWorker!.emit("message", heartbeatMessage())

      expect(handler).toHaveBeenCalledTimes(1)
      expect((handler as any).mock.calls[0][0]).toEqual({ type: "heartbeat" })
    })
  })

  // -----------------------------------------------------------------------
  // Crash on bad entry
  // -----------------------------------------------------------------------
  describe("crash on bad entry", () => {
    test("handles worker error event by tracking the error", async () => {
      const runtime = await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/bad-entry.js",
        input: buildInput(),
      })
      currentMockWorker!.emit("error", new Error("Cannot find module"))

      // After an error, the worker should report an error state
      // (but the state.ready doesn't flip — the onMessage handler or supervisor reads runtime.state)
      // The error is handled; no crash in the host
    })

    test("worker exit with non-zero code is reflected in state", async () => {
      const runtime = await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/bad-entry.js",
        input: buildInput(),
      })
      // Workers don't have exitCode/signalCode in the same way as processes
      // but we track exit in the state
      currentMockWorker!.emit("exit", 1)

      expect(runtime.state.exitCode).toBe(1)
    })

    test("worker exit with code 0 is reflected in state", async () => {
      const runtime = await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/ok-entry.js",
        input: buildInput(),
      })
      currentMockWorker!.emit("exit", 0)

      expect(runtime.state.exitCode).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // Bridge enforcement through hostBridgeHandler
  // -----------------------------------------------------------------------
  describe("bridge enforcement through hostBridgeHandler", () => {
    test("calls hostBridgeHandler when worker sends hostRequest", async () => {
      const bridgeHandler = mock(async (_requestId: string, _method: HostBridgeMethod, _params: unknown) => "result")

      await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/worker.js",
        input: buildInput(),
        hostBridgeHandler: bridgeHandler,
      })

      currentMockWorker!.emit("message", hostRequestMessage("req-1", "config.get", { key: "foo" }))

      expect(bridgeHandler).toHaveBeenCalledTimes(1)
      expect((bridgeHandler as any).mock.calls[0][0]).toBe("req-1")
      expect((bridgeHandler as any).mock.calls[0][1]).toBe("config.get")
      expect((bridgeHandler as any).mock.calls[0][2]).toEqual({ key: "foo" })
    })

    test("sends bridgeResponse with ok:true on successful handler", async () => {
      const bridgeHandler = mock(async () => ({ configValue: "ok" }))

      const runtime = await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/worker.js",
        input: buildInput(),
        hostBridgeHandler: bridgeHandler,
      })

      currentMockWorker!.emit("message", hostRequestMessage("req-2", "secret.get", { key: "api-key" }))

      // Wait for the async handler to resolve
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(currentMockWorker!.postMessage).toHaveBeenCalled()
      const callArgs = (currentMockWorker!.postMessage as any).mock.calls[0][0]
      expect(callArgs.type).toBe("bridgeResponse")
      expect(callArgs.requestId).toBe("req-2")
      expect(callArgs.ok).toBe(true)
      expect(callArgs.value).toEqual({ configValue: "ok" })
    })

    test("sends bridgeResponse with ok:false on handler error", async () => {
      const bridgeHandler = mock(async () => {
        throw new Error("permission denied")
      })

      const runtime = await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/worker.js",
        input: buildInput(),
        hostBridgeHandler: bridgeHandler,
      })

      currentMockWorker!.emit("message", hostRequestMessage("req-3", "shell.run", { cmd: "rm -rf /" }))

      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(currentMockWorker!.postMessage).toHaveBeenCalled()
      const callArgs = (currentMockWorker!.postMessage as any).mock.calls[0][0]
      expect(callArgs.type).toBe("bridgeResponse")
      expect(callArgs.requestId).toBe("req-3")
      expect(callArgs.ok).toBe(false)
      expect(callArgs.error.name).toBe("Error")
      expect(callArgs.error.message).toBe("permission denied")
    })

    test("rejects hostRequest when no hostBridgeHandler is registered", async () => {
      const runtime = await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/worker.js",
        input: buildInput(),
        // No hostBridgeHandler
      })

      currentMockWorker!.emit("message", hostRequestMessage("req-4", "network.fetch"))

      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(currentMockWorker!.postMessage).toHaveBeenCalled()
      const callArgs = (currentMockWorker!.postMessage as any).mock.calls[0][0]
      expect(callArgs.type).toBe("bridgeResponse")
      expect(callArgs.requestId).toBe("req-4")
      expect(callArgs.ok).toBe(false)
      expect(callArgs.error.message).toContain("No host bridge handler")
    })
  })

  // -----------------------------------------------------------------------
  // Log forwarding
  // -----------------------------------------------------------------------
  describe("log forwarding", () => {
    test("forwards log messages to the registered onMessage handler", async () => {
      const runtime = await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/worker.js",
        input: buildInput(),
      })

      const handler = mock((_msg: PluginToHost) => {})
      runtime.onMessage(handler)

      currentMockWorker!.emit("message", logMessage("info", "plugin started"))
      currentMockWorker!.emit("message", logMessage("warn", "low memory"))
      currentMockWorker!.emit("message", logMessage("error", "something broke"))

      expect(handler).toHaveBeenCalledTimes(3)
      expect((handler as any).mock.calls[0][0]).toEqual({ type: "log", level: "info", message: "plugin started" })
      expect((handler as any).mock.calls[1][0]).toEqual({ type: "log", level: "warn", message: "low memory" })
      expect((handler as any).mock.calls[2][0]).toEqual({ type: "log", level: "error", message: "something broke" })
    })

    test("does not crash when no onMessage handler is registered for log messages", async () => {
      const runtime = await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/worker.js",
        input: buildInput(),
      })
      // No onMessage handler registered

      expect(() => {
        currentMockWorker!.emit("message", logMessage("info", "should not crash"))
      }).not.toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // Heartbeat routing
  // -----------------------------------------------------------------------
  describe("heartbeat routing", () => {
    test("updates state.lastHeartbeat when worker sends heartbeat", async () => {
      const beforeSpawn = Date.now()
      const runtime = await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/worker.js",
        input: buildInput(),
      })

      // Advance time slightly so the heartbeat timestamp is distinguishable
      await new Promise((resolve) => setTimeout(resolve, 5))

      currentMockWorker!.emit("message", heartbeatMessage())

      expect(runtime.state.lastHeartbeat).toBeGreaterThanOrEqual(beforeSpawn)
    })

    test("heartbeat is also forwarded to the onMessage handler", async () => {
      const runtime = await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/worker.js",
        input: buildInput(),
      })

      const handler = mock((_msg: PluginToHost) => {})
      runtime.onMessage(handler)

      currentMockWorker!.emit("message", heartbeatMessage())

      expect(handler).toHaveBeenCalledTimes(1)
      expect((handler as any).mock.calls[0][0]).toEqual({ type: "heartbeat" })
    })
  })

  // -----------------------------------------------------------------------
  // send and kill
  // -----------------------------------------------------------------------
  describe("send and kill", () => {
    test("send posts a message to the worker via postMessage", async () => {
      const runtime = await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/worker.js",
        input: buildInput(),
      })

      runtime.send({ type: "invokeTool", requestId: "inv-1", toolId: "tool-1", args: { x: 1 } })

      expect(currentMockWorker!.postMessage).toHaveBeenCalledTimes(1)
      const sentMsg = (currentMockWorker!.postMessage as any).mock.calls[0][0]
      expect(sentMsg.type).toBe("invokeTool")
      expect(sentMsg.requestId).toBe("inv-1")
      expect(sentMsg.toolId).toBe("tool-1")
    })

    test("kill calls worker.terminate()", async () => {
      const runtime = await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/worker.js",
        input: buildInput(),
      })

      runtime.kill()

      expect(currentMockWorker!.terminate).toHaveBeenCalledTimes(1)
    })
  })

  // -----------------------------------------------------------------------
  // Ignore malformed messages
  // -----------------------------------------------------------------------
  describe("message robustness", () => {
    test("does not crash on malformed messages (non-object)", async () => {
      const runtime = await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/worker.js",
        input: buildInput(),
      })

      const handler = mock((_msg: PluginToHost) => {})
      runtime.onMessage(handler)

      // Workers use structured clone; malformed messages are unlikely,
      // but we verify unknown message types don't crash
      expect(() => {
        currentMockWorker!.emit("message", { type: "unknown", foo: "bar" })
      }).not.toThrow()

      // Unknown type still forwarded to handler
      expect(handler).toHaveBeenCalledTimes(1)
    })

    test("ready message with empty tools/hooks defaults safely", async () => {
      const runtime = await spawnPluginWorker({
        pluginId: "test-plugin",
        pluginDir: "/tmp/test-plugin",
        entryPath: "/tmp/test-plugin/worker.js",
        input: buildInput(),
      })

      currentMockWorker!.emit("message", { type: "ready", tools: undefined, hooks: undefined } as any)

      expect(runtime.state.ready).toBe(true)
      // Should not crash; tools and hooks may be undefined or empty
    })
  })
})
