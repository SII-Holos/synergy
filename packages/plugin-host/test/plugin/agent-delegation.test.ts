import { describe, expect, test } from "bun:test"
import { canPluginStartAgent } from "../../src/plugin/host-services"

const caller = { name: "synergy" }
const privateAgent = {
  name: "example.private-agent",
  mode: "subagent" as const,
  hidden: true,
}
const privateAgentOwner = {
  pluginId: "example-plugin",
  pluginGeneration: "generation-one",
}

describe("plugin agent delegation", () => {
  test("owner plugin can start its private Agent through the host Cortex path", () => {
    expect(
      canPluginStartAgent({
        agent: privateAgent,
        pluginOwner: privateAgentOwner,
        caller,
        pluginId: "example-plugin",
        pluginGeneration: "generation-one",
        declaredByPlugin: true,
      }),
    ).toBe(true)
  })

  test("private Agent ownership is isolated by plugin and generation", () => {
    expect(
      canPluginStartAgent({
        agent: privateAgent,
        pluginOwner: privateAgentOwner,
        caller,
        pluginId: "other-plugin",
        pluginGeneration: "generation-one",
        declaredByPlugin: true,
      }),
    ).toBe(false)
    expect(
      canPluginStartAgent({
        agent: privateAgent,
        pluginOwner: privateAgentOwner,
        caller,
        pluginId: "example-plugin",
        pluginGeneration: "generation-two",
        declaredByPlugin: true,
      }),
    ).toBe(false)
  })

  test("a declared Agent collision cannot fall through to another registered Agent", () => {
    expect(
      canPluginStartAgent({
        agent: { name: "explore", mode: "subagent" },
        caller,
        pluginId: "example-plugin",
        pluginGeneration: "generation-one",
        declaredByPlugin: true,
      }),
    ).toBe(false)
  })

  test("non-owned targets retain ordinary Synergy delegation visibility", () => {
    expect(
      canPluginStartAgent({
        agent: { name: "explore", mode: "subagent" },
        caller,
        pluginId: "example-plugin",
        pluginGeneration: "generation-one",
        declaredByPlugin: false,
      }),
    ).toBe(true)
    expect(
      canPluginStartAgent({
        agent: { name: "supervisor", mode: "subagent", hidden: true },
        caller,
        pluginId: "example-plugin",
        pluginGeneration: "generation-one",
        declaredByPlugin: false,
      }),
    ).toBe(false)
  })

  test("task.delegate never treats a primary Agent or recursive self-call as a subagent", () => {
    expect(
      canPluginStartAgent({
        agent: { ...privateAgent, mode: "primary" },
        pluginOwner: privateAgentOwner,
        caller,
        pluginId: "example-plugin",
        pluginGeneration: "generation-one",
        declaredByPlugin: true,
      }),
    ).toBe(false)
    expect(
      canPluginStartAgent({
        agent: privateAgent,
        pluginOwner: privateAgentOwner,
        caller: { name: privateAgent.name },
        pluginId: "example-plugin",
        pluginGeneration: "generation-one",
        declaredByPlugin: true,
      }),
    ).toBe(false)
  })
})
