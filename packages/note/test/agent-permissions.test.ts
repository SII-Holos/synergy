import { expect, test } from "bun:test"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { ConfigSource } from "@ericsanchezok/synergy-harness/config/source"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "./support/runtime"
import { AgentBuiltins } from "@ericsanchezok/synergy-harness/agent/builtins"
import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"

test("Note grants core subagent readers before explicit user permission overrides", async () => {
  await using runtime = await testRuntime({
    register() {
      ConfigSource.register({
        resolve: async () => ({
          agent: {
            "test-strategist": { permission: { note_read: "deny" } },
            "user-note-agent": { mode: "subagent", permission: { "*": "deny" } },
          },
        }),
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const builtin = await Agent.get("test-strategist")
        expect(PermissionNext.evaluate("note_list", "*", builtin.permission).action).toBe("allow")
        expect(PermissionNext.evaluate("note_search", "*", builtin.permission).action).toBe("allow")
        expect(PermissionNext.evaluate("note_read", "*", builtin.permission).action).toBe("deny")
        const custom = await Agent.get("user-note-agent")
        expect(PermissionNext.evaluate("note_list", "*", custom.permission).action).toBe("deny")
      },
    }),
  )
})

test("Note grants opted-in domain agents without overriding user rules or matching custom names", async () => {
  await using runtime = await testRuntime({
    register() {
      for (const [owner, name] of [
        ["boss", "fixture-boss"],
        ["library", "chronicler"],
        ["third-party", "fixture-custom"],
      ])
        AgentBuiltins.register(owner, () => ({
          [name]: {
            name: `Renamed ${name}`,
            mode: "primary",
            options: {},
            permission: PermissionNext.fromConfig({ "*": "deny" }),
          },
          ...(owner === "boss"
            ? {
                "fixture-boss-allowed": {
                  name: "Renamed coordinator",
                  mode: "primary" as const,
                  options: {},
                  permission: PermissionNext.fromConfig({ "*": "deny" }),
                },
              }
            : {}),
        }))
      ConfigSource.register({
        resolve: async () => ({ agent: { "fixture-boss": { permission: { note_edit: "deny" } } } }),
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const boss = await Agent.get("fixture-boss")
        expect(PermissionNext.evaluate("note_write", "*", boss.permission).action).toBe("allow")
        expect(PermissionNext.evaluate("note_edit", "*", boss.permission).action).toBe("deny")
        const chronicler = await Agent.get("chronicler")
        expect(PermissionNext.evaluate("note_write", "*", chronicler.permission).action).toBe("allow")
        const custom = await Agent.get("fixture-custom")
        expect(PermissionNext.evaluate("note_write", "*", custom.permission).action).toBe("deny")
        const ids = await ToolRegistry.ids()
        const available = (agent: Agent.Info) =>
          new Set(ids.filter((id) => PermissionNext.evaluate(id, "*", agent.permission).action !== "deny"))
        expect(AgentPromptContributions.render(boss, available(boss))).toEqual([])
        const allowed = await Agent.get("fixture-boss-allowed")
        expect(allowed.name).toBe("Renamed coordinator")
        expect(AgentPromptContributions.render(allowed, available(allowed)).join("\n")).toContain("durable documents")
        expect(AgentPromptContributions.render(allowed, new Set(ids.filter((id) => id !== "note_edit")))).toEqual([])
        expect(AgentPromptContributions.render(custom, new Set(ids))).toEqual([])
      },
    }),
  )
})
