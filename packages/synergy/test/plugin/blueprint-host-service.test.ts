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
        protocolVersion: 4,
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
        if (method === "blueprint.create") return { id: "loop-one", ...(params as Record<string, unknown>) }
        if (method === "blueprint.list") return []
        return { id: "loop-one" }
      },
    }),
  }
}

describe("plugin Blueprint Host Service context", () => {
  test("exposes and routes all Blueprint methods through blueprint.delegate", async () => {
    const value = context(["blueprint.delegate"])
    const loop = await value.context.blueprint?.create({ noteID: "note-one" })
    await value.context.blueprint?.start("loop-one")
    await value.context.blueprint?.get("loop-one")
    await value.context.blueprint?.list()
    await value.context.blueprint?.cancel("loop-one")

    expect(loop).toMatchObject({ id: "loop-one", noteID: "note-one" })
    expect(value.calls).toEqual([
      { method: "blueprint.create", params: { noteID: "note-one" } },
      { method: "blueprint.start", params: { loopID: "loop-one" } },
      { method: "blueprint.get", params: { loopID: "loop-one" } },
      { method: "blueprint.list", params: {} },
      { method: "blueprint.cancel", params: { loopID: "loop-one" } },
    ])
  })

  test("does not expose Blueprint methods without blueprint.delegate", () => {
    expect(context([]).context.blueprint).toBeUndefined()
  })
})
