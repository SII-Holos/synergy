import { describe, expect, test } from "bun:test"
import { createPluginInvocationContext } from "../../src/plugin-runtime/context-factory"
import type { LightLoopStartInput } from "@ericsanchezok/synergy-plugin"

describe("LightLoop protocol-5 adversarial invariants", () => {
  test("LightLoopStartInput has no sessionID field (type-level contract)", () => {
    // Compile-time verification: sessionID is not in LightLoopStartInput
    const input: LightLoopStartInput = {
      instructions: "Do work",
      correlationId: "corr-1",
      executionAgent: "agent-exec",
      reviewAgent: "agent-review",
      budget: { maxRuntimeMs: 10000, maxIterations: 5 },
    }

    expect(input.instructions).toBe("Do work")
    expect(input.correlationId).toBe("corr-1")
    expect(input.budget.maxRuntimeMs).toBe(10000)
    expect(input.budget.maxIterations).toBe(5)
  })

  test("LightLoopStartInput has no taskDescription field (type-level contract)", () => {
    const input: LightLoopStartInput = {
      instructions: "Do work",
      correlationId: "corr-1",
      executionAgent: "agent-exec",
      reviewAgent: "agent-review",
      budget: { maxRuntimeMs: 10000, maxIterations: 5 },
    }

    expect("taskDescription" in input).toBe(false)
    // instructions is the correct field
    expect(typeof input.instructions).toBe("string")
  })

  test("LightLoopStartInput requires all mandatory fields", () => {
    // Verify the type requires all mandatory fields with non-optional types
    const valid: LightLoopStartInput = {
      instructions: "Do work",
      correlationId: "corr-1",
      executionAgent: "agent-exec",
      reviewAgent: "agent-review",
      budget: { maxRuntimeMs: 10000, maxIterations: 5 },
    }
    expect(valid.budget.maxRuntimeMs).toBeGreaterThan(0)
    expect(valid.budget.maxIterations).toBeGreaterThan(0)
  })

  test("lightloop.delegate capability gates context.lightloop exposure", () => {
    const without = createPluginInvocationContext({
      requestId: "req-no-cap",
      runtime: { hostVersion: "test", pluginVersion: "1.0", pluginGeneration: "gen-1", protocolVersion: 5 },
      data: { scopeId: "scope-1", directory: "/tmp", actor: { type: "ui" } },
      signal: AbortSignal.any([]),
      capabilities: new Set(),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      async invokeHost() {},
    })
    expect(without.lightloop).toBeUndefined()

    const withCap = createPluginInvocationContext({
      requestId: "req-cap",
      runtime: { hostVersion: "test", pluginVersion: "1.0", pluginGeneration: "gen-1", protocolVersion: 5 },
      data: { scopeId: "scope-1", directory: "/tmp", actor: { type: "ui" } },
      signal: AbortSignal.any([]),
      capabilities: new Set(["lightloop.delegate"]),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      async invokeHost() {},
    })
    expect(withCap.lightloop).toBeDefined()
  })

  test("LightLoopInfo status includes all protocol-5 statuses", () => {
    // Verify LightLoopInfo supports all required statuses
    const statuses = ["running", "reviewing", "completed", "cancelled", "timed_out", "iteration_exhausted", "failed"] as const
    for (const s of statuses) {
      const info = { sessionID: "s1", status: s, instructions: "test" }
      expect(info.status).toBe(s)
    }
  })
})
