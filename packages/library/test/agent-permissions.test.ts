import { expect, test } from "bun:test"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { AgentBuiltins } from "@ericsanchezok/synergy-harness/agent/builtins"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { ConfigSource } from "@ericsanchezok/synergy-harness/config/source"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerLibraryAgentPermissions } from "../src/agent-permissions"
import { registerConfig } from "../src/config-schema"

test("Library owns primary memory grants and preserves explicit denials and config overrides", async () => {
  const primary = PrimaryAgentIdentity.names.general
  await using runtime = await testRuntime({
    register() {
      registerConfig()
      registerLibraryAgentPermissions()
      AgentBuiltins.register("fixture", () => ({
        denied: {
          name: "denied",
          mode: "primary",
          permission: PermissionNext.fromConfig({ memory_write: "deny" }),
          options: {},
        },
        hidden: { name: "hidden", mode: "primary", hidden: true, permission: [], options: {} },
      }))
      ConfigSource.register({
        resolve: async () => ({
          library: { memory: { enabled: false } },
          agent: { [primary]: { permission: { memory_search: "allow" } } },
        }),
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const agent = await Agent.get(primary)
        const action = (name: string) => PermissionNext.evaluate(name, "*", agent.permission).action
        expect(action("memory_write")).toBe("allow")
        expect(action("memory_edit")).toBe("allow")
        expect(action("memory_search")).toBe("allow")
        expect(action("memory_get")).toBe("deny")
        const denied = await Agent.get("denied")
        expect(PermissionNext.evaluate("memory_write", "*", denied.permission).action).toBe("deny")
        expect(denied.permission.some((rule) => rule.permission === "memory_edit")).toBe(false)
        expect((await Agent.get("hidden")).permission.some((rule) => rule.permission.startsWith("memory_"))).toBe(false)
      },
    }),
  )
})
