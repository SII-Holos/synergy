import { afterEach, describe, expect, mock, test } from "bun:test"
import path from "path"
import { capability, compilePluginManifest, definePlugin } from "@ericsanchezok/synergy-plugin"
import type { LightLoopStartInput } from "@ericsanchezok/synergy-plugin"
import { Agent } from "../../src/agent/agent"
import { Cortex } from "../../src/cortex"
import { cancelLightLoop, getLightLoop, startLightLoop } from "../../src/plugin/host-services"
import { createPluginInvocationContext } from "../../src/plugin-runtime/context-factory"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { LightLoopRuntime } from "../../src/session/light-loop-runtime"
import { LightLoopTerminalStore } from "../../src/session/light-loop-terminal-hook"
import { tmpdir } from "../fixture/fixture"

const originalAgentGet = Agent.get
const originalPluginOwner = Agent.pluginOwner
const originalPrepare = Cortex.prepare
const originalStart = Cortex.start
const originalCancel = Cortex.cancel

afterEach(() => {
  ;(Agent.get as any) = originalAgentGet
  ;(Agent.pluginOwner as any) = originalPluginOwner
  ;(Cortex.prepare as any) = originalPrepare
  ;(Cortex.start as any) = originalStart
  ;(Cortex.cancel as any) = originalCancel
})

async function runAtomicStartTest(input?: { startError?: Error }) {
  await using tmp = await tmpdir({ git: true, config: { controlProfile: "full_access" } })
  const pluginId = "lightloop-atomic-test"
  const pluginGeneration = "generation-one"
  const executionAgent = "lightloop-atomic-test.executor"
  const reviewAgent = "lightloop-atomic-test.reviewer"
  const manifest = compilePluginManifest(
    definePlugin({
      id: pluginId,
      version: "1.0.0",
      description: "LightLoop atomic start test",
      capabilities: [capability("lightloop.delegate")],
      contributions: [],
    }),
    { generation: pluginGeneration },
  )
  await Bun.write(path.join(tmp.path, "plugin.json"), JSON.stringify(manifest))

  return ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const parent = await Session.create({ controlProfile: "full_access" })
      const agents = new Map([
        [executionAgent, { name: executionAgent, mode: "subagent" as const, hidden: true }],
        [reviewAgent, { name: reviewAgent, mode: "subagent" as const, hidden: true }],
      ])
      ;(Agent.get as any) = mock(async (name: string) => agents.get(name) ?? originalAgentGet(name))
      ;(Agent.pluginOwner as any) = mock((agent: { name: string }) =>
        agents.has(agent.name) ? { pluginId, pluginGeneration } : originalPluginOwner(agent as any),
      )

      let task: Awaited<ReturnType<typeof Cortex.prepare>> | undefined
      const startSnapshots: Array<Session.Info["workflow"]> = []
      const cancelled: string[] = []
      ;(Cortex.prepare as any) = mock(async (request: Parameters<typeof Cortex.prepare>[0]) => {
        const session = await Session.create({
          parentID: request.parentSessionID,
          cortex: {
            taskID: "ctx_lightloop_atomic",
            parentSessionID: request.parentSessionID,
            parentMessageID: request.parentMessageID,
            description: request.description,
            agent: request.agent,
            executionRole: request.executionRole,
            status: "queued",
            startedAt: Date.now(),
          },
        })
        task = {
          id: "ctx_lightloop_atomic",
          sessionID: session.id,
          parentSessionID: request.parentSessionID,
          parentMessageID: request.parentMessageID,
          description: request.description,
          prompt: request.prompt,
          agent: request.agent,
          executionRole: request.executionRole,
          category: request.category,
          status: "queued",
          startedAt: Date.now(),
        } as Awaited<ReturnType<typeof Cortex.prepare>>
        return task
      })
      ;(Cortex.start as any) = mock(async () => {
        startSnapshots.push((await Session.get(task!.sessionID)).workflow)
        if (input?.startError) throw input.startError
        return task!
      })
      ;(Cortex.cancel as any) = mock(async (taskID: string) => {
        cancelled.push(taskID)
      })

      let result: Awaited<ReturnType<typeof startLightLoop>> | undefined
      let error: Error | undefined
      try {
        result = await startLightLoop({
          pluginId,
          pluginGeneration,
          scopeId: ScopeContext.current.scope.id,
          pluginDir: tmp.path,
          context: {
            pluginId,
            pluginDir: tmp.path,
            sessionID: parent.id,
            messageID: "msg_lightloop_atomic",
            agent: "synergy-max",
            directory: tmp.path,
          },
          request: {
            instructions: "Finish the implementation",
            correlationId: "corr-lightloop-atomic",
            executionAgent,
            reviewAgent,
            model: { providerID: "test-provider", modelID: "test-model" },
            budget: { maxRuntimeMs: 30_000, maxIterations: 5 },
          },
        })
      } catch (caught) {
        error = caught instanceof Error ? caught : new Error(String(caught))
      }

      const child = task ? await Session.get(task.sessionID) : undefined
      if (task) LightLoopRuntime.cancelDeadline(task.sessionID)
      return { result, error, task, child, startSnapshots, cancelled }
    },
  })
}

describe("plugin LightLoop Host Service", () => {
  test("persists the workflow before starting Cortex execution", async () => {
    const state = await runAtomicStartTest()

    expect(state.error).toBeUndefined()
    expect(state.result).toMatchObject({ status: "running", instructions: "Finish the implementation" })
    expect(state.startSnapshots).toHaveLength(1)
    expect(state.startSnapshots[0]).toMatchObject({
      kind: "lightloop",
      status: "running",
      instructions: "Finish the implementation",
      pluginOwner: { pluginId: "lightloop-atomic-test", pluginGeneration: "generation-one" },
    })
    expect(state.cancelled).toEqual([])
  })

  test("cancels and archives the prepared task when Cortex start fails", async () => {
    const state = await runAtomicStartTest({ startError: new Error("start failed") })

    expect(state.error?.message).toBe("start failed")
    expect(state.startSnapshots[0]?.kind).toBe("lightloop")
    expect(state.cancelled).toEqual(["ctx_lightloop_atomic"])
    expect(state.child?.workflow).toBeUndefined()
    expect(state.child?.time.archived).toBeNumber()
  })
  test("exposes start/get/cancel through lightloop.delegate", async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const context = createPluginInvocationContext({
      requestId: "request-lightloop",
      runtime: {
        hostVersion: "test",
        pluginVersion: "1.2.0",
        pluginGeneration: "generation-one",
        protocolVersion: 5,
      },
      data: { scopeId: "scope-one", sessionId: "session-one", directory: "/workspace", actor: { type: "ui" } },
      signal: AbortSignal.any([]),
      capabilities: new Set(["lightloop.delegate"]),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      async invokeHost(method, params) {
        calls.push({ method, params })
      },
    })

    const input: LightLoopStartInput = {
      instructions: "Finish the implementation",
      correlationId: "corr-1",
      executionAgent: "agent-exec",
      reviewAgent: "agent-review",
      budget: { maxRuntimeMs: 30000, maxIterations: 5 },
    }

    await context.lightloop!.start(input)
    expect(calls).toEqual([{ method: "lightloop.start", params: input }])
  })

  test("get/cancel delegate to lightloop routes", async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const context = createPluginInvocationContext({
      requestId: "request-lightloop-getcancel",
      runtime: {
        hostVersion: "test",
        pluginVersion: "1.2.0",
        pluginGeneration: "generation-one",
        protocolVersion: 5,
      },
      data: { scopeId: "scope-one", sessionId: "session-one", directory: "/workspace", actor: { type: "ui" } },
      signal: AbortSignal.any([]),
      capabilities: new Set(["lightloop.delegate"]),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      async invokeHost(method, params) {
        calls.push({ method, params })
      },
    })

    await context.lightloop!.get("ses-exec-1")
    expect(calls[0]).toEqual({ method: "lightloop.get", params: { sessionID: "ses-exec-1" } })

    await context.lightloop!.cancel("ses-exec-1")
    expect(calls[1]).toEqual({ method: "lightloop.cancel", params: { sessionID: "ses-exec-1" } })
  })

  test("returns terminal snapshots and makes repeated cancellation idempotent", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      fn: async () => {
        const session = await Session.create({})
        await LightLoopTerminalStore.put(session, {
          sessionID: session.id,
          status: "completed",
          instructions: "Finish the implementation",
          pluginOwner: {
            pluginId: "test-plugin",
            pluginGeneration: "generation-one",
            scopeId: scope.id,
          },
          hookDeliveredAt: Date.now(),
          createdAt: Date.now(),
        })
        const input = {
          pluginId: "test-plugin",
          pluginGeneration: "generation-one",
          scopeId: scope.id,
          sessionID: session.id,
        }

        expect(await getLightLoop(input)).toEqual({
          sessionID: session.id,
          status: "completed",
          instructions: "Finish the implementation",
        })
        expect(
          await cancelLightLoop({
            ...input,
            context: {
              sessionID: session.id,
              messageID: "msg_terminal_cancel",
              agent: "synergy-max",
            },
          }),
        ).toEqual({
          sessionID: session.id,
          status: "completed",
          instructions: "Finish the implementation",
        })
      },
    })
  })

  test("lightloop.delegate capability gates context.lightloop exposure", async () => {
    const context = createPluginInvocationContext({
      requestId: "request-without-capability",
      runtime: {
        hostVersion: "test",
        pluginVersion: "1.2.0",
        pluginGeneration: "generation-one",
        protocolVersion: 5,
      },
      data: { scopeId: "scope-one", directory: "/workspace", actor: { type: "lifecycle" } },
      signal: AbortSignal.any([]),
      capabilities: new Set(),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      async invokeHost() {},
    })
    expect(context.lightloop).toBeUndefined()
  })

  test("LightLoopStartInput has no sessionID or taskDescription", () => {
    const input: LightLoopStartInput = {
      instructions: "Do work",
      correlationId: "corr-1",
      executionAgent: "agent-exec",
      reviewAgent: "agent-review",
      budget: { maxRuntimeMs: 10000, maxIterations: 5 },
    }
    expect(input.instructions).toBe("Do work")
    expect("sessionID" in input).toBe(false)
    expect("taskDescription" in input).toBe(false)
  })
})
