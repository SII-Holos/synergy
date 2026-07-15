import { describe, expect, test } from "bun:test"
import { createPluginInvocationContext } from "../../src/plugin-runtime/context-factory"

function context(capabilities: string[]) {
  const calls: Array<{ method: string; params: unknown }> = []
  return {
    calls,
    context: createPluginInvocationContext({
      requestId: "request-blueprint",
      runtime: {
        hostVersion: "test",
        pluginVersion: "1.2.0",
        pluginGeneration: "generation-one",
        protocolVersion: 5,
      },
      data: {
        scopeId: "scope-one",
        sessionId: "session-one",
        directory: "/workspace",
        actor: { type: "agent", agent: "synergy-max", messageId: "message-one", callId: "call-one" },
      },
      signal: AbortSignal.any([]),
      capabilities: new Set(capabilities),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      async invokeHost(method, params) {
        calls.push({ method, params })
        return { id: "loop-one" }
      },
    }),
  }
}

describe("plugin Blueprint Host Service context (protocol 5)", () => {
  test("exposes start/get/cancel through blueprint.delegate", async () => {
    const value = context(["blueprint.delegate"])
    const startInput = {
      title: "Test",
      markdown: "# Test",
      sourceDigest: "hash",
      correlationId: "c1",
      executionAgent: "agent1",
      auditAgent: "agent2",
      budget: { maxRuntimeMs: 10000, maxIterations: 5 },
    }
    await value.context.blueprint!.start(startInput)
    await value.context.blueprint!.get("loop-one")
    await value.context.blueprint!.cancel("loop-one")

    expect(value.calls).toEqual([
      { method: "blueprint.start", params: startInput },
      { method: "blueprint.get", params: { loopID: "loop-one" } },
      { method: "blueprint.cancel", params: { loopID: "loop-one" } },
    ])
  })

  test("does not expose Blueprint methods without blueprint.delegate", () => {
    expect(context([]).context.blueprint).toBeUndefined()
  })
})
