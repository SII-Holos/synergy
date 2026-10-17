import { expect, test } from "bun:test"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
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

async function open(selected: boolean, denied = false) {
  return testRuntime({
    composition: RuntimeComponents.compose([
      localRuntime({ workers: false, environment: false }),
      ...(selected ? [plugins(), mcp()] : []),
    ]),
    register() {
      ConfigSource.register({
        resolve: async () => ({
          agent: {
            scout: {
              name: "Renamed researcher",
              ...(denied ? { permission: { mcp__fixture__read: "deny" as const } } : {}),
            },
          },
        }),
      })
    },
  })
}

async function inspect() {
  return ScopeContext.provide({
    scope: Scope.home(),
    fn: async () => {
      const agent = await Agent.get("scout")
      return {
        name: agent.name,
        permission: PermissionNext.evaluate("mcp__fixture__read", "*", agent.permission).action,
        resources: await ResourceSources.read(),
      }
    },
  })
}

test("selected mcp owns research permission and lazy resource discovery across Runtimes", async () => {
  await using core = await open(false)
  const selected = await open(true)
  try {
    expect((await core.run(inspect)).permission).toBe("deny")
    expect((await core.run(inspect)).resources).toEqual([])
    const state = await selected.run(inspect)
    expect(state.name).toBe("Renamed researcher")
    expect(state.permission).toBe("allow")
    expect(state.resources.find((row) => row.owner === "mcp")).toMatchObject({ processCount: 0 })
  } finally {
    await selected.close()
  }
  expect((await core.run(inspect)).resources).toEqual([])
  await using denied = await open(true, true)
  expect((await denied.run(inspect)).permission).toBe("deny")
})
