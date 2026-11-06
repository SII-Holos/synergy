import { describe, expect, test } from "bun:test"
import { createPluginInvocationContext, contributionGatedCapabilities } from "../../src/plugin-runtime/context-factory"

describe("plugin task host context", () => {
  test("the complete capability context preserves the public RPC method and argument contract", async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const capabilities = new Set([
      "session.read",
      "session.control",
      "workspace.read",
      "workspace.write",
      "task.delegate",
      "blueprint.delegate",
      "lightloop.delegate",
      "settings.read",
      "settings.write",
      "secrets",
      "asset.write",
      "shell.execute",
      "runtime.endpoint.read",
      "tool.invoke",
      "agent.call",
    ])
    const context = createPluginInvocationContext({
      requestId: "all-services",
      runtime: { hostVersion: "test", pluginVersion: "1.0", pluginGeneration: "g", protocolVersion: 4 },
      data: {
        scopeId: "scope",
        sessionId: "session",
        directory: "/workspace",
        actor: { type: "agent", agent: "fixture", messageId: "message", callId: "call" },
      },
      signal: AbortSignal.any([]),
      capabilities,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      async invokeHost(method, params) {
        calls.push({ method, params })
        return { text: "reply" }
      },
    })
    const task = { subagent: "fixture", description: "Inspect", prompt: "Inspect", correlationId: "c" }
    const handle = { taskId: "task", sessionId: "session" }
    const budget = { maxRuntimeMs: 1000, maxIterations: 1 }
    const blueprint = {
      title: "Plan",
      markdown: "Plan",
      sourceDigest: "digest",
      correlationId: "c",
      executionAgent: "execute",
      auditAgent: "audit",
      budget,
    }
    const lightloop = {
      instructions: "Work",
      correlationId: "c",
      executionAgent: "execute",
      reviewAgent: "review",
      budget,
    }
    const asset = { data: "text", mime: "text/plain", filename: "fixture.txt" }
    const shell: { command: [string, ...string[]] } = { command: ["echo", "fixture"] }
    const agent = { agent: "fixture", text: "hello" }
    await context.events.publish("updated", { value: 1 })
    await context.session?.get?.("session")
    await context.session?.abort?.("session")
    await context.workspace?.read?.("file")
    await context.workspace?.metadata?.()
    await context.workspace?.write?.("file", "content")
    await context.task?.start(task)
    await context.task?.run(task)
    await context.task?.current()
    await context.task?.get(handle)
    await context.task?.cancel(handle)
    await context.blueprint?.start(blueprint)
    await context.blueprint?.get("loop")
    await context.blueprint?.cancel("loop")
    await context.lightloop?.start(lightloop)
    await context.lightloop?.get("session")
    await context.lightloop?.cancel("session")
    await context.settings?.get?.()
    await context.settings?.replace?.({ enabled: true })
    await context.secrets?.get("key")
    await context.secrets?.set("key", "value")
    await context.secrets?.delete("key")
    await context.asset?.create(asset)
    await context.shell?.run(shell)
    await context.runtimeEndpoint?.get()
    await context.tools?.invoke("read", { filePath: "file" })
    await context.agent?.call(agent)
    await context.agent?.start({ ...agent, correlationId: "c" })
    expect(calls).toEqual([
      { method: "event.publish", params: { eventId: "updated", payload: { value: 1 } } },
      { method: "session.get", params: { sessionId: "session" } },
      { method: "session.abort", params: { sessionId: "session" } },
      { method: "workspace.read", params: { path: "file" } },
      { method: "workspace.metadata", params: {} },
      { method: "workspace.write", params: { path: "file", content: "content" } },
      { method: "task.start", params: task },
      { method: "task.run", params: task },
      { method: "task.current", params: {} },
      { method: "task.get", params: handle },
      { method: "task.cancel", params: handle },
      { method: "blueprint.start", params: blueprint },
      { method: "blueprint.get", params: { loopID: "loop" } },
      { method: "blueprint.cancel", params: { loopID: "loop" } },
      { method: "lightloop.start", params: lightloop },
      { method: "lightloop.get", params: { sessionID: "session" } },
      { method: "lightloop.cancel", params: { sessionID: "session" } },
      { method: "settings.get", params: {} },
      { method: "settings.replace", params: { values: { enabled: true } } },
      { method: "secrets.get", params: { key: "key" } },
      { method: "secrets.set", params: { key: "key", value: "value" } },
      { method: "secrets.delete", params: { key: "key" } },
      { method: "asset.create", params: asset },
      { method: "shell.run", params: shell },
      { method: "runtime.endpoint.get", params: {} },
      { method: "tool.invoke", params: { toolId: "read", input: { filePath: "file" } } },
      { method: "agent.call", params: agent },
      { method: "agent.start", params: { ...agent, correlationId: "c" } },
    ])
    const gated = contributionGatedCapabilities(capabilities, { requires: ["agent.call"] })
    expect(gated.has("agent.call")).toBe(true)
    expect(gated.has("runtime.endpoint.read")).toBe(false)
    expect(gated.has("workspace.read")).toBe(true)
  })

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
