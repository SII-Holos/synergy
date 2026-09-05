import { afterEach, describe, expect, mock, test } from "bun:test"
import { agent, capability, compilePluginManifest, definePlugin, operation } from "@ericsanchezok/synergy-plugin"
import { z } from "zod"
import { Agent } from "@/agent/agent"
import { AgentCall } from "@/agent/call"
import { executePluginHostService } from "@/plugin/host-services-runtime"
import { pluginAgentCallRuntime } from "@/plugin-runtime/agent-call-runtime"
import { Plugin } from "@/plugin"
import { ScopeContext } from "@/scope/context"
import { ObservabilityStore } from "@/observability/store"
import { tmpdir } from "../fixture/fixture"
import { Config } from "@/config/config"
import "../../src/product-registration"

const originalAgentGet = Agent.get
const originalPluginOwner = Agent.pluginOwner
const originalAgentCall = AgentCall.text

afterEach(() => {
  ;(Agent.get as any) = originalAgentGet
  ;(Agent.pluginOwner as any) = originalPluginOwner
  ;(AgentCall.text as any) = originalAgentCall
})

describe("plugin agent.call Host Service", () => {
  test("allows owned hidden Agents, enforces bounds, and denies foreign Agents", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const manifest = compilePluginManifest(
      definePlugin({
        id: "agent-call-test",
        version: "1.0.0",
        description: "Agent call boundary",
        capabilities: [
          capability("agent.call", {
            maxRuntimeMs: 1000,
            maxInputChars: 20,
            maxOutputChars: 30,
            modelRoles: ["mini", "thinking"],
          }),
        ],
        contributions: [
          operation({
            id: "call",
            type: "command",
            requires: ["agent.call"],
            input: z.object({}),
            output: z.object({}),
            handler: async () => ({}),
          }),
        ],
      }),
      { generation: "generation-one" },
    )
    const ownedAgent = { name: "owned", hidden: true }
    ;(Agent.get as any) = mock(async (name: string) => (name === "missing" ? undefined : ownedAgent))
    ;(Agent.pluginOwner as any) = mock(() => ({
      pluginId: manifest.id,
      pluginGeneration: manifest.artifacts.generation,
    }))
    let received: AgentCall.TextInput | undefined
    ;(AgentCall.text as any) = mock(async (input: AgentCall.TextInput) => {
      received = input
      return {
        text: "answer",
        model: { providerID: "provider", id: "model", headers: { "x-internal": "secret" } },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }
    })

    const invoke = (agent: string, params: Record<string, unknown> = {}, handlerId = "operation:call") =>
      executePluginHostService({
        pluginId: manifest.id,
        pluginDir: tmp.path,
        manifest,
        handlerId,
        invocation: { scopeId: scope.id, directory: tmp.path, actor: { type: "ui" } },
        method: "agent.call",
        params: {
          agent,
          text: "hello",
          modelRole: "thinking",
          timeoutMs: 5000,
          maxOutputChars: 5000,
          ...params,
        },
        signal: new AbortController().signal,
      })

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await expect(invoke("owned")).resolves.toEqual({ text: "answer" })
        expect(received).toMatchObject({
          modelRole: "thinking",
          timeoutMs: 1000,
          maxInputChars: 20,
          maxOutputChars: 30,
          retries: 1,
        })
        await expect(invoke("owned", { modelRole: "creative" })).rejects.toMatchObject({
          code: "PLUGIN_AGENT_MODEL_ROLE_DENIED",
        })
        await expect(invoke("owned", { modelRole: "invalid-role" })).rejects.toMatchObject({
          code: "PLUGIN_AGENT_MODEL_ROLE_INVALID",
        })
        await expect(invoke("owned", {}, "operation:missing")).rejects.toThrow(
          'does not declare capability "agent.call"',
        )
        ;(Agent.pluginOwner as any) = mock(() => ({ pluginId: "foreign", pluginGeneration: "other" }))
        await expect(invoke("foreign")).rejects.toMatchObject({ code: "PLUGIN_AGENT_NOT_OWNED" })
        await expect(invoke("missing")).rejects.toMatchObject({ code: "PLUGIN_AGENT_NOT_FOUND" })
      },
    })
  })

  test("calls owned hidden Agent by public name when contribution id differs", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const manifest = compilePluginManifest(
      definePlugin({
        id: "agent-call-id-diff-name",
        version: "1.0.0",
        description: "Agent call id != name",
        capabilities: [capability("agent.call", { maxRuntimeMs: 1000 })],
        contributions: [
          agent({
            id: "contribution-id-name",
            agent: {
              name: "public_name",
              description: "Owned hidden Agent",
              prompt: "Answer the request.",
              mode: "subagent",
              hidden: true,
            },
          }),
          operation({
            id: "call",
            type: "command",
            requires: ["agent.call"],
            input: z.object({}),
            output: z.object({}),
            handler: async () => ({}),
          }),
        ],
      }),
      { generation: "generation-one" },
    )
    const originalAgentEntries = Plugin.agentEntries
    ;(Plugin as any).agentEntries = async () => [
      {
        contributionId: "contribution-id-name",
        pluginId: manifest.id,
        pluginGeneration: manifest.artifacts.generation,
        name: "public_name",
        description: "Owned hidden Agent",
        prompt: "Answer the request.",
        mode: "subagent",
        hidden: true,
      },
    ]
    ;(AgentCall.text as any) = mock(async (_input: AgentCall.TextInput) => ({ text: "answer" }))

    const invoke = (agentName: string) =>
      executePluginHostService({
        pluginId: manifest.id,
        pluginDir: tmp.path,
        manifest,
        handlerId: "operation:call",
        invocation: { scopeId: scope.id, directory: tmp.path, actor: { type: "ui" } },
        method: "agent.call",
        params: { agent: agentName, text: "hello" },
        signal: new AbortController().signal,
      })

    try {
      await ScopeContext.provide({
        scope,
        fn: async () => {
          await Agent.reload()
          await expect(invoke("public_name")).resolves.toEqual({ text: "answer" })
          await expect(invoke("contribution-id-name")).rejects.toMatchObject({ code: "PLUGIN_AGENT_NOT_FOUND" })
        },
      })
    } finally {
      ;(Plugin as any).agentEntries = originalAgentEntries
      await Agent.reload()
    }
  })

  test("starts a sessionless call without awaiting it and detaches from the invocation signal", async () => {
    await using tmp = await tmpdir({ git: true })
    const scope = await tmp.scope()
    const manifest = compilePluginManifest(
      definePlugin({
        id: "agent-start-test",
        version: "1.0.0",
        description: "Agent start boundary",
        capabilities: [
          capability("agent.call", {
            maxRuntimeMs: 1_000,
            maxInputChars: 20,
            maxOutputChars: 30,
            modelRoles: ["mini", "thinking"],
          }),
        ],
        contributions: [
          agent({
            id: "metadata",
            agent: {
              name: "metadata_agent",
              description: "Owned hidden metadata Agent",
              prompt: "Return metadata.",
              mode: "subagent",
              hidden: true,
            },
          }),
          operation({
            id: "start",
            type: "command",
            requires: ["agent.call"],
            input: z.object({}),
            output: z.object({}),
            handler: async () => ({}),
          }),
        ],
      }),
      { generation: "generation-start" },
    )
    const ownedAgent = { name: "metadata_agent", hidden: true }
    ;(Agent.get as any) = mock(async () => ownedAgent)
    ;(Agent.pluginOwner as any) = mock(() => ({
      pluginId: manifest.id,
      pluginGeneration: manifest.artifacts.generation,
    }))
    let callSignal: AbortSignal | undefined
    let finish!: (value: { text: string }) => void
    ;(AgentCall.text as any) = mock(async (input: AgentCall.TextInput) => {
      callSignal = input.signal
      return new Promise<{ text: string }>((resolve) => {
        finish = resolve
      })
    })
    const invocationController = new AbortController()
    const invoke = (text = "hello") =>
      executePluginHostService({
        pluginId: manifest.id,
        pluginDir: tmp.path,
        manifest,
        handlerId: "operation:start",
        invocation: { scopeId: scope.id, directory: tmp.path, actor: { type: "ui" } },
        method: "agent.start",
        params: {
          agent: "metadata_agent",
          text,
          correlationId: "correction:one",
          modelRole: "mini",
          timeoutMs: 5_000,
          maxOutputChars: 5_000,
        },
        signal: invocationController.signal,
      })

    const first = (await invoke()) as { callId: string }
    expect(first).toEqual({ callId: expect.any(String) })
    expect(pluginAgentCallRuntime.activeCount(manifest.id)).toBe(1)
    expect(await invoke()).toEqual(first)
    await expect(invoke("changed")).rejects.toMatchObject({
      code: "PLUGIN_AGENT_CALL_CONFLICT",
    })
    await expect(
      executePluginHostService({
        pluginId: manifest.id,
        pluginDir: tmp.path,
        manifest,
        handlerId: "operation:start",
        invocation: { scopeId: scope.id, directory: tmp.path, actor: { type: "ui" } },
        method: "agent.start",
        params: {
          agent: "metadata_agent",
          text: "hello",
          correlationId: "correction:one",
          modelRole: "thinking",
        },
        signal: invocationController.signal,
      }),
    ).rejects.toMatchObject({
      code: "PLUGIN_AGENT_CALL_CONFLICT",
    })
    invocationController.abort()
    expect(callSignal?.aborted).toBe(false)

    finish({ text: "metadata" })
    for (let attempt = 0; attempt < 50 && pluginAgentCallRuntime.activeCount(manifest.id); attempt++) {
      await Bun.sleep(1)
    }
    expect(pluginAgentCallRuntime.activeCount(manifest.id)).toBe(0)
    for (let attempt = 0; attempt < 200; attempt++) {
      const event = ObservabilityStore.queryEvents({ type: "log.record" }).find((item) => {
        const data = JSON.parse(item.data_json)
        return (
          data.callId === first.callId && data.message === "plugin Agent call terminal delivery was not acknowledged"
        )
      })
      if (event) break
      await Bun.sleep(10)
    }
    const event = ObservabilityStore.queryEvents({ type: "log.record" }).find((item) => {
      const data = JSON.parse(item.data_json)
      return data.callId === first.callId && data.message === "plugin Agent call terminal delivery was not acknowledged"
    })
    expect(event).toBeDefined()
    const data = JSON.parse(event!.data_json)
    expect(data).toMatchObject({
      service: "plugin.agent-call",
      pluginId: manifest.id,
      generation: manifest.artifacts.generation,
      scopeId: scope.id,
      callId: first.callId,
      terminalStatus: "completed",
      deliveryStatus: "plugin_mismatch",
      handlerCount: 0,
      errorSummary: "plugin_generation_inactive",
    })
    expect(data).not.toHaveProperty("correlationId")
    expect(data).not.toHaveProperty("text")
    expect(JSON.stringify(data)).not.toContain("metadata")
  })
})

test("clamps agent.call runtime to the configured agentCallMaxRuntimeMs ceiling", async () => {
  await using tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  const manifest = compilePluginManifest(
    definePlugin({
      id: "agent-call-config-timeout",
      version: "1.0.0",
      description: "Agent call configured timeout boundary",
      capabilities: [
        capability("agent.call", {
          maxRuntimeMs: 10_000,
          maxInputChars: 20,
          maxOutputChars: 30,
        }),
      ],
      contributions: [
        operation({
          id: "call",
          type: "command",
          requires: ["agent.call"],
          input: z.object({}),
          output: z.object({}),
          handler: async () => ({}),
        }),
      ],
    }),
    { generation: "generation-config-timeout" },
  )
  const ownedAgent = { name: "owned", hidden: true }
  ;(Agent.get as any) = mock(async () => ownedAgent)
  ;(Agent.pluginOwner as any) = mock(() => ({
    pluginId: manifest.id,
    pluginGeneration: manifest.artifacts.generation,
  }))
  let received: AgentCall.TextInput | undefined
  ;(AgentCall.text as any) = mock(async (input: AgentCall.TextInput) => {
    received = input
    return {
      text: "answer",
      model: { providerID: "provider", id: "model", headers: {} },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }
  })

  const invoke = (params: Record<string, unknown> = {}) =>
    executePluginHostService({
      pluginId: manifest.id,
      pluginDir: tmp.path,
      manifest,
      handlerId: "operation:call",
      invocation: { scopeId: scope.id, directory: tmp.path, actor: { type: "ui" } },
      method: "agent.call",
      params: { agent: "owned", text: "hello", ...params },
      signal: new AbortController().signal,
    })

  await ScopeContext.provide({
    scope,
    fn: async () => {
      await Config.state.reset()
      await Config.update({
        pluginRuntimePolicy: {
          limits: {
            agentCallMaxRuntimeMs: 5_000,
          },
        },
      } as any)
      await Config.state.reset()

      // Plugin omits timeoutMs → configured ceiling 5s is used.
      await invoke()
      expect(received?.timeoutMs).toBe(5_000)

      // Plugin declares maxRuntimeMs 10s → still clamped to configured 5s.
      await invoke({ timeoutMs: 9_000 })
      expect(received?.timeoutMs).toBe(5_000)
    },
  })
})
