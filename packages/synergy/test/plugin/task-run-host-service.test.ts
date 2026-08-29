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
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { createPluginInvocationContext } from "../../src/plugin-runtime/context-factory"
import { executePluginHostService } from "../../src/plugin/host-services-runtime"
import { Bus } from "../../src/bus"
import { Cortex } from "../../src/cortex"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionInvoke } from "../../src/session/invoke"
import { tmpdir } from "../fixture/fixture"
// Registers the SessionCortexRuntime provider task.run waits through.
import "../../src/product-registration"
import { Config } from "../../src/config/config"

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
                actor: { type: "agent", agent: "synergy", messageId: "msg_parent", callId: "call-one" },
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

  test("starts an owned hidden Agent by public name when contribution id differs", async () => {
    await using tmp = await tmpdir({ git: true, config: { controlProfile: "full_access" } })
    const scope = await tmp.scope()
    const manifest = compilePluginManifest(
      definePlugin({
        id: "task-start-public-name",
        version: "1.0.0",
        description: "task.start public Agent name test",
        capabilities: [capability("task.delegate", { agents: ["public-supervisor"] })],
        contributions: [
          agent({
            id: "private-supervisor-contribution",
            agent: {
              name: "public-supervisor",
              description: "Owned hidden supervisor",
              prompt: "Supervise the task.",
              mode: "subagent",
              hidden: true,
            },
          }),
        ],
      }),
      { generation: "generation-one" },
    )
    await Bun.write(path.join(tmp.path, "plugin.json"), JSON.stringify(manifest))
    const originalAgentEntries = Plugin.agentEntries
    ;(Plugin as any).agentEntries = async () => [
      {
        contributionId: "private-supervisor-contribution",
        pluginId: manifest.id,
        pluginGeneration: manifest.artifacts.generation,
        name: "public-supervisor",
        description: "Owned hidden supervisor",
        prompt: "Supervise the task.",
        mode: "subagent",
        hidden: true,
      },
    ]

    await ScopeContext.provide({
      scope,
      fn: async () => {
        const parent = await Session.create({})
        let handle: { taskId: string; sessionId: string } | undefined
        try {
          await Agent.reload()
          handle = (await executePluginHostService({
            pluginId: manifest.id,
            pluginDir: tmp.path,
            manifest,
            invocation: {
              scopeId: scope.id,
              sessionId: parent.id,
              directory: tmp.path,
              actor: { type: "agent", agent: "synergy", messageId: "msg_parent", callId: "call-one" },
            },
            method: "task.start",
            params: {
              ...request,
              subagent: "public-supervisor",
              model: { providerID: "test-provider", modelID: "test-model" },
              visibility: "hidden",
            },
            signal: AbortSignal.timeout(5_000),
          })) as { taskId: string; sessionId: string }
          expect(Cortex.get(handle.taskId)).toMatchObject({
            agent: "public-supervisor",
            owner: {
              pluginId: manifest.id,
              pluginGeneration: manifest.artifacts.generation,
              scopeId: scope.id,
            },
          })
        } finally {
          if (handle) {
            await Cortex.cancel(handle.taskId).catch(() => {})
            await Session.remove(handle.sessionId).catch(() => {})
          }
          await Session.remove(parent.id).catch(() => {})
          Cortex.reset()
          ;(Plugin as any).agentEntries = originalAgentEntries
          await Agent.reload()
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

test("task.run wait ceiling uses the configured taskRunWaitTimeoutMs when the task has no active runtime", async () => {
  await using tmp = await tmpdir({ git: true, config: { controlProfile: "full_access" } })
  const scope = await tmp.scope()
  const manifest = compilePluginManifest(
    definePlugin({
      id: "task-run-wait-timeout-test",
      version: "1.0.0",
      description: "task.run wait timeout test",
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
      const originalWaitFor = Cortex.waitFor
      const originalGet = Cortex.get
      let waitForSeconds: number | undefined
      ;(SessionInvoke.invokeInternal as unknown) = mock(async () => new Promise(() => {}))
      // Simulate a task whose active runtime is no longer in memory so the
      // configured taskRunWaitTimeoutMs fallback drives the wait ceiling.
      ;(Cortex as any).get = mock(() => undefined)
      ;(Cortex as any).waitFor = mock(async (_taskID: string, timeoutSeconds: number) => {
        waitForSeconds = timeoutSeconds
        return undefined
      })

      const parent = await Session.create({})
      let childSessionID: string | undefined
      try {
        await Config.state.reset()
        await Config.update({
          pluginRuntimePolicy: { limits: { taskRunWaitTimeoutMs: 4_000 } },
        } as any)
        await Config.state.reset()

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
          signal: AbortSignal.timeout(10_000),
        })

        for (let attempt = 0; attempt < 200 && waitForSeconds === undefined; attempt++) {
          await Bun.sleep(10)
        }
        // The configured 4s ceiling + 5s buffer is the waitFor timeout.
        expect(waitForSeconds).toBe(9)
        // waitFor resolved immediately (undefined); task.run returns the
        // durable snapshot from the child Session's cortex record.
        const result = (await running) as { taskId: string; sessionId: string }
        childSessionID = result.sessionId
        expect(result.taskId).toBeDefined()
      } finally {
        ;(Cortex as any).waitFor = originalWaitFor
        ;(Cortex as any).get = originalGet
        ;(SessionInvoke.invokeInternal as unknown) = originalInvokeInternal
        Cortex.reset()
        if (childSessionID) await Session.remove(childSessionID).catch(() => {})
        await Session.remove(parent.id).catch(() => {})
      }
    },
  })
})

test("task.run wait ceiling clamps to taskRunWaitTimeoutMs even when the active task has a longer execution timeout", async () => {
  await using tmp = await tmpdir({ git: true, config: { controlProfile: "full_access" } })
  const scope = await tmp.scope()
  const manifest = compilePluginManifest(
    definePlugin({
      id: "task-run-wait-ceiling-test",
      version: "1.0.0",
      description: "task.run wait ceiling test",
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
      const originalWaitFor = Cortex.waitFor
      const originalGet = Cortex.get
      let waitForSeconds: number | undefined
      ;(SessionInvoke.invokeInternal as unknown) = mock(async () => new Promise(() => {}))
      // The active task carries the default 120s execution timeout; the
      // configured 4s wait ceiling must clamp the wait independently.
      ;(Cortex as any).get = mock(() => ({ taskId: "task-wait-ceiling", timeoutMs: 120_000 }))
      ;(Cortex as any).waitFor = mock(async (_taskID: string, timeoutSeconds: number) => {
        waitForSeconds = timeoutSeconds
        return undefined
      })

      const parent = await Session.create({})
      let running: Promise<unknown> | undefined
      try {
        await Config.state.reset()
        await Config.update({
          pluginRuntimePolicy: { limits: { taskRunWaitTimeoutMs: 4_000 } },
        } as any)
        await Config.state.reset()

        running = executePluginHostService({
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
          signal: AbortSignal.timeout(10_000),
        })
        // waitFor resolves immediately; the subsequent getPluginTask rejects
        // because the mock active task has no owner. Swallow it.
        running.catch(() => {})

        for (let attempt = 0; attempt < 200 && waitForSeconds === undefined; attempt++) {
          await Bun.sleep(10)
        }
        // min(120s task timeout, 4s ceiling) + 5s buffer → 9s wait.
        expect(waitForSeconds).toBe(9)
      } finally {
        ;(Cortex as any).waitFor = originalWaitFor
        ;(Cortex as any).get = originalGet
        ;(SessionInvoke.invokeInternal as unknown) = originalInvokeInternal
        Cortex.reset()
        await Session.remove(parent.id).catch(() => {})
      }
    },
  })
})
