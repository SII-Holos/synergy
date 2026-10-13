import { expect, test } from "bun:test"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { ConfigSource } from "@ericsanchezok/synergy-harness/config/source"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerAgentPermissions } from "../src/agent-permissions"
import { registerMediaPrompts } from "../src/agent-prompts"
import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"

for (const selected of [false, true]) {
  for (const denied of [false, true]) {
    test(`media guidance follows registration, availability and configured denial (${selected}, ${denied})`, async () => {
      const tools = ["render", "scan_document", "look_at"]
      await using runtime = await testRuntime({
        register() {
          if (selected) {
            registerAgentPermissions()
            registerMediaPrompts()
          }
          ConfigSource.register({
            resolve: async () => ({
              agent: {
                [PrimaryAgentIdentity.names.coding]: {
                  permission: denied ? { render: "deny", scan_document: "deny", look_at: "deny" } : {},
                },
              },
            }),
          })
        },
      })
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          async fn() {
            const agent = await Agent.get(PrimaryAgentIdentity.names.coding)
            const available = new Set(
              tools.filter((tool) => PermissionNext.evaluate(tool, "*", agent.permission).action !== "deny"),
            )
            const guidance = AgentPromptContributions.render(agent, available).join("\n")
            for (const tool of tools) expect(guidance.includes(`Use ${tool}`)).toBe(selected && !denied)
            expect(AgentPromptContributions.render(agent, new Set())).toEqual([])
          },
        }),
      )
    })
  }
}

test("media grants preserve the builtin role and respect explicit denials", async () => {
  await using runtime = await testRuntime({
    register() {
      registerAgentPermissions()
      ConfigSource.register({
        resolve: async () => ({
          agent: {
            [PrimaryAgentIdentity.names.coding]: { name: "renamed", permission: { scan_document: "deny" } },
          },
        }),
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const coding = await Agent.get(PrimaryAgentIdentity.names.coding)
        expect(coding.name).toBe("renamed")
        expect(PermissionNext.evaluate("scan_document", "*", coding.permission).action).toBe("deny")
        const agents = await Agent.list()
        const reader = agents.find(
          (agent) => agent.mode === "subagent" && agent.permission.some((rule) => rule.permission === "scan_document"),
        )!
        expect(reader).toBeDefined()
        expect(PermissionNext.evaluate("scan_document", "*", reader.permission).action).toBe("allow")
        expect(PermissionNext.evaluate("look_at", "*", reader.permission).action).toBe("allow")
      },
    }),
  )
})
