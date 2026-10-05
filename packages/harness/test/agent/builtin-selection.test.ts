import { expect, test } from "bun:test"
import { PrimaryAgentIdentity } from "../../src/agent/primary-identity"
import { Agent } from "../../src/agent/agent"
import { AgentBuiltins } from "../../src/agent/builtins"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { testRuntime } from "../support/runtime"

test("an embedded host selects internal agents without product agent families", async () => {
  await using runtime = await testRuntime({
    register() {
      AgentBuiltins.selectDefaultFamilies(["internal"])
      AgentBuiltins.register("embedded", () => ({
        assistant: { name: "assistant", mode: "primary", permission: [], options: {}, native: true },
      }))
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const agents = await Agent.list()
        expect(agents.map((agent) => agent.name).sort()).toEqual([
          "agent-generator",
          "assistant",
          "compaction",
          "smart-allow",
          "summary",
          "title",
        ])
        expect(agents.filter((agent) => !agent.hidden).map((agent) => agent.name)).toEqual(["assistant"])
        expect(() => AgentBuiltins.selectDefaultFamilies([])).toThrow("before opening the Runtime")
        expect(() => AgentBuiltins.register("late", () => ({}))).toThrow("before opening the Runtime")
      },
    }),
  )
})

test("default agent family selection is isolated between runtimes", async () => {
  await using selected = await testRuntime({ register: () => AgentBuiltins.selectDefaultFamilies([]) })
  await using product = await testRuntime()
  const names = (runtime: typeof selected) =>
    runtime.run(() =>
      ScopeContext.provide({ scope: Scope.home(), fn: async () => (await Agent.list()).map((agent) => agent.name) }),
    )
  expect(await names(selected)).toEqual([])
  expect(await names(product)).toContain(PrimaryAgentIdentity.names.general)
  expect(await names(product)).toContain("compaction")
})
