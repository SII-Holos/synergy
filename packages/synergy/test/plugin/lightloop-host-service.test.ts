import { describe, expect, test } from "bun:test"
import { createPluginInvocationContext } from "../../src/plugin-runtime/context-factory"
import type { LightLoopStartInput } from "@ericsanchezok/synergy-plugin"

describe("plugin LightLoop Host Service", () => {
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
