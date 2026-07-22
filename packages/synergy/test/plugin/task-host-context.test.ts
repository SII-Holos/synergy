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
        if (method === "task.current") {
          return {
            taskId: "task-one",
            sessionId: "session-one",
            status: "running",
            owner: {
              pluginId: "example-plugin",
              pluginGeneration: "generation-one",
              scopeId: "scope-one",
              correlationId: "stage-one",
            },
          }
        }
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
    expect(await context.task?.current()).toMatchObject({
      taskId: "task-one",
      owner: { correlationId: "stage-one" },
    })
    expect(await context.task?.get(handle!)).toMatchObject({ status: "running" })
    await context.task?.cancel(handle!)

    expect(calls.map((call) => call.method)).toEqual(["task.start", "task.current", "task.get", "task.cancel"])
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

  test("exposes sessionless Agent calls only with agent.call", async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const context = createPluginInvocationContext({
      requestId: "request-agent",
      runtime: {
        hostVersion: "test",
        pluginVersion: "1.0.0",
        pluginGeneration: "generation-one",
        protocolVersion: 5,
      },
      data: { scopeId: "scope-one", directory: "/workspace", actor: { type: "ui" } },
      signal: AbortSignal.any([]),
      capabilities: new Set(["agent.call"]),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      async invokeHost(method, params) {
        calls.push({ method, params })
        return { text: "result" }
      },
    })
    await expect(context.agent?.call({ agent: "language", text: "hello" })).resolves.toEqual({ text: "result" })
    expect(calls).toEqual([{ method: "agent.call", params: { agent: "language", text: "hello" } }])

    const denied = createPluginInvocationContext({
      requestId: "request-agent-denied",
      runtime: context.runtime,
      data: { scopeId: "scope-one", directory: "/workspace", actor: { type: "ui" } },
      signal: AbortSignal.any([]),
      capabilities: new Set(),
      log: context.log,
      async invokeHost() {},
    })
    expect(denied.agent).toBeUndefined()
  })
})
