import { expect, test } from "bun:test"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { AgentBuiltins } from "@ericsanchezok/synergy-harness/agent/builtins"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { ConfigSource } from "@ericsanchezok/synergy-harness/config/source"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { ResourceSources } from "@ericsanchezok/synergy-harness/observability/resource-sources"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"
import { mcp } from "../src/component"

async function open(selected: boolean, config: Config.Info = {}) {
  return testRuntime({
    composition: RuntimeComponents.compose([
      localRuntime({ workers: false, environment: false }),
      ...(selected ? [plugins(), mcp()] : []),
    ]),
    register() {
      AgentBuiltins.register("fixture-owner", () => ({
        "fixture-owned": {
          name: "fixture-owned",
          mode: "subagent",
          permission: PermissionNext.fromConfig({ "*": "deny" }),
          options: {},
        },
      }))
      ConfigSource.register({ resolve: async () => config })
    },
  })
}

async function inspect() {
  return ScopeContext.provide({
    scope: Scope.home(),
    fn: async () => {
      const agent = await Agent.get("inspector")
      return {
        name: agent.name,
        permission: PermissionNext.evaluate("mcp__fixture__read", "*", agent.permission).action,
        resources: await ResourceSources.read(),
      }
    },
  })
}

test("selected mcp owns default access and lazy resource discovery across Runtimes", async () => {
  await using core = await open(false)
  const selected = await open(true, { agent: { inspector: { name: "Renamed inspector" } } })
  try {
    expect((await core.run(inspect)).permission).toBe("deny")
    expect((await core.run(inspect)).resources).toEqual([])
    const state = await selected.run(inspect)
    expect(state.name).toBe("Renamed inspector")
    expect(state.permission).toBe("allow")
    expect(state.resources.find((row) => row.owner === "mcp")).toMatchObject({ processCount: 0 })
  } finally {
    await selected.close()
  }
  expect((await core.run(inspect)).resources).toEqual([])
  await using denied = await open(true, { agent: { inspector: { permission: { mcp__fixture__read: "deny" } } } })
  expect((await denied.run(inspect)).permission).toBe("deny")
})

test("MCP read, write and unknown tool names are available to every resolved Agent by default", async () => {
  await using runtime = await open(true, {
    agent: { "configured-primary": { mode: "primary" }, "configured-subagent": { mode: "subagent" } },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const agents = await Agent.list()
        expect(agents.map((agent) => agent.name)).toEqual(
          expect.arrayContaining([
            ...Object.values(PrimaryAgentIdentity.names),
            "inspector",
            "fixture-owned",
            "configured-primary",
            "configured-subagent",
          ]),
        )
        for (const agent of agents) {
          for (const tool of ["mcp__fixture__read", "mcp__fixture__update", "mcp__future_server__future_tool"]) {
            expect(PermissionNext.evaluate(tool, "*", agent.permission).action, `${agent.name}: ${tool}`).toBe("allow")
          }
        }
        const inspector = await Agent.get("inspector")
        expect(PermissionNext.evaluate("edit", "*", inspector.permission).action).toBe("deny")
        expect(PermissionNext.evaluate("task", "*", inspector.permission).action).toBe("deny")
      },
    }),
  )
})

test("global and Agent configuration override MCP component defaults", async () => {
  await using runtime = await open(true, {
    permission: { "mcp__*": "ask", "mcp__blocked__*": "deny" },
    agent: {
      inspector: { permission: { mcp__fixture__read: "allow", mcp__fixture__update: "deny" } },
      "configured-denied": { mode: "subagent", permission: { "*": "deny" } },
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const primary = await Agent.get(PrimaryAgentIdentity.names.general)
        const inspector = await Agent.get("inspector")
        for (const agent of [primary, inspector]) {
          expect(PermissionNext.evaluate("mcp__blocked__read", "*", agent.permission).action).toBe("deny")
          expect(PermissionNext.evaluate("mcp__other__read", "*", agent.permission).action).toBe("ask")
        }
        expect(PermissionNext.evaluate("mcp__fixture__read", "*", primary.permission).action).toBe("ask")
        expect(PermissionNext.evaluate("mcp__fixture__read", "*", inspector.permission).action).toBe("allow")
        expect(PermissionNext.evaluate("mcp__fixture__update", "*", inspector.permission).action).toBe("deny")
        const denied = await Agent.get("configured-denied")
        expect(PermissionNext.evaluate("mcp__fixture__read", "*", denied.permission).action).toBe("deny")
      },
    }),
  )
})
