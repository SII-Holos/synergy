import { afterEach, describe, expect, mock, test } from "bun:test"
import { capability, compilePluginManifest, definePlugin, operation } from "@ericsanchezok/synergy-plugin"
import { z } from "zod"
import { Agent } from "@/agent/agent"
import { AgentCall } from "@/agent/call"
import { executePluginHostService } from "@/plugin/host-services-runtime"
import { ScopeContext } from "@/scope/context"
import { tmpdir } from "../fixture/fixture"

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
        capabilities: [capability("agent.call", { maxRuntimeMs: 1000, maxInputChars: 20, maxOutputChars: 30 })],
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
      return { text: "answer" }
    })

    const invoke = (agent: string, params: Record<string, unknown> = {}, handlerId = "operation:call") =>
      executePluginHostService({
        pluginId: manifest.id,
        pluginDir: tmp.path,
        manifest,
        handlerId,
        invocation: { scopeId: scope.id, directory: tmp.path, actor: { type: "ui" } },
        method: "agent.call",
        params: { agent, text: "hello", timeoutMs: 5000, maxOutputChars: 5000, ...params },
        signal: new AbortController().signal,
      })

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await expect(invoke("owned")).resolves.toEqual({ text: "answer" })
        expect(received).toMatchObject({ timeoutMs: 1000, maxInputChars: 20, maxOutputChars: 30, retries: 1 })
        await expect(invoke("owned", {}, "operation:missing")).rejects.toThrow(
          'does not declare capability "agent.call"',
        )
        ;(Agent.pluginOwner as any) = mock(() => ({ pluginId: "foreign", pluginGeneration: "other" }))
        await expect(invoke("foreign")).rejects.toMatchObject({ code: "PLUGIN_AGENT_NOT_OWNED" })
        await expect(invoke("missing")).rejects.toMatchObject({ code: "PLUGIN_AGENT_NOT_FOUND" })
      },
    })
  })
})
