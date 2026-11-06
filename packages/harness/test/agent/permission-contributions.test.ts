import { expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { AgentBuiltins } from "../../src/agent/builtins"
import { AgentPermissionContributions } from "../../src/agent/permission-contributions"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { testRuntime } from "../support/runtime"
import { AgentPluginSource } from "../../src/agent/plugin-source"
import { ConfigSource } from "../../src/config/source"
import { PermissionNext } from "../../src/permission/next"

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

test("final contributions retain plugin declaration precedence and explicit user agent rules", async () => {
  await using runtime = await testRuntime({
    register() {
      AgentBuiltins.selectDefaultFamilies([])
      AgentPermissionContributions.register("fixture", contribution)
      AgentPluginSource.register({
        agentEntries: async () =>
          ["allow", "ask", "deny"].map((action) => ({
            name: `plugin-${action}`,
            description: "Fixture plugin agent",
            prompt: "Fixture prompt",
            contributionId: `fixture.${action}`,
            pluginId: "fixture-plugin",
            pluginGeneration: "generation-one",
            mode: "primary" as const,
            permission: { fixture_read: action as PermissionNext.Action },
          })),
      })
      ConfigSource.register({
        resolve: async () => ({
          permission: { "fixture_*": "deny" },
          agent: { configured: { name: "Renamed configured", permission: { fixture_read: "ask" } } },
        }),
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        for (const action of ["allow", "ask", "deny"] as const) {
          const agent = await Agent.get(`plugin-${action}`)
          expect(agent.source).toBe("plugin")
          expect(AgentPermissionContributions.identity(agent)).toMatchObject({
            owner: "fixture-plugin",
            source: "plugin",
          })
          expect(PermissionNext.evaluate("fixture_read", "*", agent.permission).action).toBe(action)
        }
        const configured = await Agent.get("configured")
        expect(configured.name).toBe("Renamed configured")
        expect(configured.source).toBe("config")
        expect(PermissionNext.evaluate("fixture_read", "*", configured.permission).action).toBe("ask")
      },
    }),
  )
})
