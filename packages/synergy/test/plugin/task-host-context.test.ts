import { describe, expect, test } from "bun:test"
import { createPluginInvocationContext } from "../../src/plugin-runtime/context-factory"

describe("plugin task host context", () => {
  test("exposes non-blocking delegated task methods through one capability", async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const context = createPluginInvocationContext({
      requestId: "request-one",
      runtime: {
        hostVersion: "test",
        pluginVersion: "1.0.0",
        pluginGeneration: "generation-one",
        protocolVersion: 4,
      },
      data: {
        scopeId: "scope-one",
        directory: "/workspace",
        actor: { type: "lifecycle" },
      },
      signal: AbortSignal.any([]),
      capabilities: new Set(["task.delegate"]),
      log: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
      async invokeHost(method, params) {
        calls.push({ method, params })
        if (method === "task.start") return { taskId: "task-one", sessionId: "session-one" }
        if (method === "task.get") {
          return { taskId: "task-one", sessionId: "session-one", status: "running" }
        }
      },
    })

    const handle = await context.task?.start({
      subagent: "explore",
      description: "Inspect",
      prompt: "Inspect the repository",
      correlationId: "stage-one",
      parent: { sessionId: "parent", messageId: "message" },
    })
    expect(handle).toEqual({ taskId: "task-one", sessionId: "session-one" })
    expect(await context.task?.get(handle!)).toMatchObject({ status: "running" })
    await context.task?.cancel(handle!)

    expect(calls.map((call) => call.method)).toEqual(["task.start", "task.get", "task.cancel"])
  })

  test("does not expose task methods without task.delegate", () => {
    const context = createPluginInvocationContext({
      requestId: "request-two",
      runtime: {
        hostVersion: "test",
        pluginVersion: "1.0.0",
        pluginGeneration: "generation-one",
        protocolVersion: 4,
      },
      data: { scopeId: "scope-one", directory: "/workspace", actor: { type: "ui" } },
      signal: AbortSignal.any([]),
      capabilities: new Set(),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      async invokeHost() {},
    })
    expect(context.task).toBeUndefined()
  })
})
