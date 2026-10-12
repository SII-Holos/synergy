import { expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { AgentBuiltins } from "../../src/agent/builtins"
import { AgentPermissionContributions } from "../../src/agent/permission-contributions"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { testRuntime } from "../support/runtime"

const contribution: AgentPermissionContributions.Contribution = () => [
  { permission: "fixture_read", action: "allow", pattern: "*" },
]
function registerAgent() {
  AgentBuiltins.selectDefaultFamilies([])
  AgentBuiltins.register("fixture", () => ({
    assistant: { name: "assistant", mode: "primary", permission: [], options: {} },
  }))
}

test("Agent permissions only receive selected owner contributions in their Runtime", async () => {
  await using selected = await testRuntime({
    register() {
      registerAgent()
      AgentPermissionContributions.register("fixture", contribution)
      AgentPermissionContributions.register("fixture", contribution)
      expect(() => AgentPermissionContributions.register("fixture", () => [])).toThrow("Duplicate Agent permission")
    },
  })
  await using bare = await testRuntime({ register: registerAgent })
  for (const [runtime, expected] of [
    [selected, 1],
    [bare, 0],
  ] as const) {
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const agent = await Agent.get("assistant")
          expect(agent.permission.filter((rule) => rule.permission === "fixture_read")).toHaveLength(expected)
          expect(agent.permission.filter((rule) => /^(memory|note|agenda)_/.test(rule.permission))).toEqual([])
          expect(() => AgentPermissionContributions.register("late", contribution)).toThrow(
            "before opening the Runtime",
          )
        },
      }),
    )
  }
})
