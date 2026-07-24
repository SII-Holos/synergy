import path from "path"
import { describe, expect, mock, test } from "bun:test"
import {
  agent,
  capability,
  compilePluginManifest,
  definePlugin,
  type PluginInvocationContext,
  type PluginTaskSnapshot,
  type PluginTaskStartInput,
} from "@ericsanchezok/synergy-plugin"
import { createPluginInvocationContext } from "../../src/plugin-runtime/context-factory"
import { executePluginHostService } from "../../src/plugin/host-services-runtime"
import { Bus } from "../../src/bus"
import { Cortex } from "../../src/cortex"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInvoke } from "../../src/session/invoke"
import { tmpdir } from "../fixture/fixture"

type TaskRunContext = PluginInvocationContext & {
  task?: NonNullable<PluginInvocationContext["task"]> & {
    run(input: PluginTaskStartInput): Promise<PluginTaskSnapshot>
  }
}

const request: PluginTaskStartInput = {
  subagent: "example-plugin.private-agent",
  description: "Build a structured plan",
  prompt: "Return the requested plan",
  correlationId: "stage-one",
  output: {
    mode: "structured",
    schema: {
      type: "object",
      required: ["steps"],
      properties: { steps: { type: "array", items: { type: "string" } } },
    },
  },
}

const terminalSnapshot: PluginTaskSnapshot = {
  taskId: "task-one",
  sessionId: "session-one",
  status: "completed",
  owner: {
    pluginId: "example-plugin",
    pluginGeneration: "generation-one",
    scopeId: "scope-one",
    correlationId: "stage-one",
  },
  agent: "example-plugin.private-agent",
  startedAt: 100,
  completedAt: 125,
  outputConfig: request.output,
  output: { mode: "structured", value: { steps: ["inspect", "implement"] } },
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 2,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
    cost: 0.01,
  },
}

function context(
  input: {
    capabilities?: string[]
    signal?: AbortSignal
    invokeHost?: (method: string, params: unknown) => Promise<unknown>
  } = {},
): TaskRunContext {
  return createPluginInvocationContext({
    requestId: "request-task-run",
    runtime: {
      hostVersion: "test",
      pluginVersion: "1.0.0",
      pluginGeneration: "generation-one",
      protocolVersion: 6,
    },
    data: {
      scopeId: "scope-one",
      sessionId: "parent-session",
      directory: "/workspace",
      actor: { type: "agent", agent: "synergy", messageId: "parent-message", callId: "call-one" },
    },
    signal: input.signal ?? AbortSignal.any([]),
    capabilities: new Set(input.capabilities ?? ["task.delegate"]),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    async invokeHost(method, params) {
      return input.invokeHost?.(method, params)
    },
  }) as TaskRunContext
}

describe("plugin task.run Host Service", () => {
  test("is injected only with approved task.delegate capability", () => {
    expect(context().task?.run).toBeFunction()
    expect(context({ capabilities: [] }).task).toBeUndefined()
  })

  test("uses one native Host call and returns the terminal PluginTaskSnapshot unchanged", async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const ctx = context({
      async invokeHost(method, params) {
        calls.push({ method, params })
        return terminalSnapshot
      },
    })

    await expect(ctx.task!.run(request)).resolves.toEqual(terminalSnapshot)
    expect(calls).toEqual([{ method: "task.run", params: request }])
  })

  test("preserves terminal planner errors as PluginTaskSnapshot data", async () => {
    const failed: PluginTaskSnapshot = {
      ...terminalSnapshot,
      status: "error",
      output: undefined,
      error: "planner could not satisfy the output schema",
    }
    const ctx = context({
      async invokeHost() {
        return failed
      },
    })

    await expect(ctx.task!.run(request)).resolves.toEqual(failed)
  })

  test("fails closed when a declared hidden Agent is not owned by the invoking plugin generation", async () => {
    await using tmp = await tmpdir({ git: true, config: { controlProfile: "full_access" } })
    const scope = await tmp.scope()
    const manifest = compilePluginManifest(
      definePlugin({
        id: "task-run-owner-test",
        version: "1.0.0",
        description: "task.run ownership test",
        capabilities: [capability("task.delegate", { agents: ["supervisor"] })],
        contributions: [
          agent({
            id: "supervisor",
            agent: {
              name: "supervisor",
              description: "Manifest collision with a hidden Host Agent",
              prompt: "Never invoked",
              mode: "subagent",
              hidden: true,
            },
          }),
        ],
      }),
      { generation: "generation-one" },
    )
    await Bun.write(path.join(tmp.path, "plugin.json"), JSON.stringify(manifest))

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const parent = await Session.create({})
        try {
          await expect(
            executePluginHostService({
              pluginId: manifest.id,
              pluginDir: tmp.path,
              manifest,
              invocation: {
                scopeId: scope.id,
                sessionId: parent.id,
                directory: tmp.path,
                actor: { type: "agent", agent: "synergy", messageId: "parent-message", callId: "call-one" },
              },
              method: "task.run" as never,
              params: { ...request, subagent: "supervisor" },
              signal: AbortSignal.timeout(5_000),
            }),
          ).rejects.toThrow('Agent "supervisor" is not registered to the invoking plugin generation')
        } finally {
          await Session.remove(parent.id)
        }
      },
    })
  })

  test("invocation abort cancels the native child and rejects as abort", async () => {
    await using tmp = await tmpdir({ git: true, config: { controlProfile: "full_access" } })
    const scope = await tmp.scope()
    const manifest = compilePluginManifest(
      definePlugin({
        id: "task-run-abort-test",
        version: "1.0.0",
        description: "task.run abort test",
        capabilities: [capability("task.delegate", { agents: ["developer"] })],
        contributions: [],
      }),
      { generation: "generation-one" },
    )
    await Bun.write(path.join(tmp.path, "plugin.json"), JSON.stringify(manifest))

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const originalInvokeInternal = SessionInvoke.invokeInternal
        const controller = new AbortController()
        const created =
          Promise.withResolvers<ReturnType<typeof Cortex.get> extends infer T ? Exclude<T, undefined> : never>()
        const unsubscribe = Bus.subscribe(Cortex.Event.TaskCreated, (event) => created.resolve(event.properties.task))
        let childSessionID: string | undefined
        ;(SessionInvoke.invokeInternal as unknown) = mock(async () => new Promise(() => {}))

        const parent = await Session.create({})
        try {
          const running = executePluginHostService({
            pluginId: manifest.id,
            pluginDir: tmp.path,
            manifest,
            invocation: {
              scopeId: scope.id,
              sessionId: parent.id,
              directory: tmp.path,
              actor: { type: "agent", agent: "synergy", messageId: "msg_parent", callId: "call-one" },
            },
            method: "task.run" as never,
            params: {
              ...request,
              subagent: "developer",
              model: { providerID: "test-provider", modelID: "test-model" },
              output: { mode: "final_response" },
            },
            signal: controller.signal,
          })
          const task = await Promise.race([
            created.promise,
            running.then(() => {
              throw new Error("task.run returned before creating a Cortex child")
            }),
          ])
          childSessionID = task.sessionID

          controller.abort()

          await expect(running).rejects.toMatchObject({ name: "AbortError" })
          expect(Cortex.get(task.id)?.status).toBe("cancelled")
          expect((await Session.get(task.sessionID)).cortex?.status).toBe("cancelled")
        } finally {
          unsubscribe()
          ;(SessionInvoke.invokeInternal as unknown) = originalInvokeInternal
          Cortex.reset()
          if (childSessionID) await Session.remove(childSessionID).catch(() => {})
          await Session.remove(parent.id).catch(() => {})
        }
      },
    })
  })

  test("rejects invocation abort instead of returning an ordinary planner failure", async () => {
    const controller = new AbortController()
    const calls: string[] = []
    const ctx = context({
      signal: controller.signal,
      async invokeHost(method) {
        calls.push(method)
        return new Promise((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () =>
              reject(Object.assign(new Error("Plugin invocation aborted"), { name: "AbortError", code: "CANCELLED" })),
            { once: true },
          )
        })
      },
    })

    const running = ctx.task!.run(request)
    controller.abort()

    await expect(running).rejects.toMatchObject({ name: "AbortError", code: "CANCELLED" })
    expect(calls).toEqual(["task.run"])
  })
})
