import { describe, expect, mock, test } from "bun:test"

// Mock only the leaf DOM dependency; message-part stays real so this test
// cannot break barrel-importing tests that share the worker, and cannot be
// broken by them (module-cache order no longer matters for registration).
mock.module("../../../../src/components/basic-tool", () => ({
  BasicTool: () => null,
  SmartTool: () => null,
  ToolResultPresentationProvider: () => null,
}))

const { getTool } = await import("../../../../src/components/tool-registry-lazy")
await import("../../../../src/components/tool/renders/agent-config")

describe("agent_config tool render registration", () => {
  test("registers a reachable renderer in the shared tool registry", () => {
    const render = getTool("agent_config")
    expect(render).toBeDefined()
    expect(typeof render).toBe("function")
  })
})
