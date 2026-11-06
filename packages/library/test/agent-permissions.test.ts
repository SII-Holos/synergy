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
import type { Config } from "@ericsanchezok/synergy-harness/config/config"

for (const layer of ["global", "agent"] as const) {
  for (const fixture of [
    { permission: { "memory_*": "deny" }, pattern: "*", action: "deny" },
    { permission: { "*": "deny" }, pattern: "*", action: "deny" },
    { permission: { memory_write: "ask" }, pattern: "*", action: "ask" },
    { permission: { "memory_*": { "protected/*": "deny" } }, pattern: "protected/fact", action: "deny" },
  ] satisfies { permission: Config.Permission; pattern: string; action: PermissionNext.Action }[]) {
    test(`Library respects ${layer} user ${fixture.action} rules ${JSON.stringify(fixture.permission)}`, async () => {
      const primary = PrimaryAgentIdentity.names.general
      await using runtime = await testRuntime({
        register() {
          registerConfig()
          registerLibraryAgentPermissions()
          ConfigSource.register({
            resolve: async () =>
              layer === "global"
                ? { permission: fixture.permission }
                : { agent: { [primary]: { permission: fixture.permission } } },
          })
        },
      })
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            const agent = await Agent.get(primary)
            expect(PermissionNext.evaluate("memory_write", fixture.pattern, agent.permission).action).toBe(
              fixture.action,
            )
          },
        }),
      )
    })
  }
}

for (const change of [{ name: "renamed" }, { mode: "all" as const }, { hidden: true }]) {
  test(`recall restrictions use builtin identity before config overrides ${JSON.stringify(change)}`, async () => {
    const primary = PrimaryAgentIdentity.names.general
    await using runtime = await testRuntime({
      register() {
        registerConfig()
        registerLibraryAgentPermissions()
        ConfigSource.register({
          resolve: async () => ({
            library: { memory: { enabled: false } },
            agent: { [primary]: change },
          }),
        })
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const agent = await Agent.get(primary)
          expect(PermissionNext.evaluate("memory_search", "*", agent.permission).action).toBe("deny")
          expect(PermissionNext.evaluate("memory_get", "*", agent.permission).action).toBe("deny")
        },
      }),
    )
  })
}

test("Library default primary grants survive builtin wildcard defaults and renaming, while hidden agents stay restricted", async () => {
  await using runtime = await testRuntime({
    register() {
      registerConfig()
      registerLibraryAgentPermissions()
      AgentBuiltins.register("fixture-defaults", () =>
        Object.fromEntries(
          ["deny", "ask"].flatMap((action) =>
            [false, true].map((hidden) => {
              const name = `${action}-${hidden}`
              return [
                name,
                {
                  name: `Renamed ${name}`,
                  mode: "primary" as const,
                  hidden,
                  permission: PermissionNext.fromConfig({ "*": action as PermissionNext.Action }),
                  options: {},
                },
              ]
            }),
          ),
        ),
      )
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        for (const action of ["deny", "ask"] as const) {
          for (const hidden of [false, true]) {
            const agent = await Agent.get(`${action}-${hidden}`)
            expect(agent.name).toBe(`Renamed ${action}-${hidden}`)
            for (const tool of ["memory_write", "memory_edit"])
              expect(PermissionNext.evaluate(tool, "*", agent.permission).action).toBe(hidden ? action : "allow")
          }
        }
      },
    }),
  )
})

test("explicit per-agent permission retains precedence over global rules after Library defaults", async () => {
  const primary = PrimaryAgentIdentity.names.general
  await using runtime = await testRuntime({
    register() {
      registerConfig()
      registerLibraryAgentPermissions()
      ConfigSource.register({
        resolve: async () => ({
          permission: { "memory_*": "deny" },
          agent: { [primary]: { name: "Renamed primary", permission: { memory_write: "allow" } } },
        }),
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const agent = await Agent.get(primary)
        expect(agent.name).toBe("Renamed primary")
        expect(PermissionNext.evaluate("memory_write", "*", agent.permission).action).toBe("allow")
        expect(PermissionNext.evaluate("memory_edit", "*", agent.permission).action).toBe("deny")
      },
    }),
  )
})

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
