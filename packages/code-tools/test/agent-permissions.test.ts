import { expect, test } from "bun:test"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { ConfigSource } from "@ericsanchezok/synergy-harness/config/source"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerAgentPermissions } from "../src/agent-permissions"
import { registerCodePrompts } from "../src/agent-prompts"
import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"

for (const selected of [false, true]) {
  for (const denied of [false, true]) {
    test(`code guidance follows registration, availability and configured denial (${selected}, ${denied})`, async () => {
      await using runtime = await testRuntime({
        register() {
          if (selected) {
            registerAgentPermissions()
            registerCodePrompts()
          }
          ConfigSource.register({
            resolve: async () => ({
              agent: {
                [PrimaryAgentIdentity.names.coding]: { permission: denied ? { parse_code: "deny" } : {} },
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
              PermissionNext.evaluate("parse_code", "*", agent.permission).action === "deny" ? [] : ["parse_code"],
            )
            expect(AgentPromptContributions.render(agent, available).join("\n").includes("Use parse_code")).toBe(
              selected && !denied,
            )
            expect(AgentPromptContributions.render(agent, new Set())).toEqual([])
          },
        }),
      )
    })
  }
}

test("code tools grant the selected builtin role before explicit configuration", async () => {
  await using runtime = await testRuntime({
    register() {
      registerAgentPermissions()
      ConfigSource.register({
        resolve: async () => ({
          agent: {
            [PrimaryAgentIdentity.names.coding]: { name: "renamed", permission: { ast_grep: "allow" } },
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
        expect(PermissionNext.evaluate("parse_code", "*", coding.permission).action).toBe("allow")
        expect(PermissionNext.evaluate("ast_grep", "*", coding.permission).action).toBe("allow")
        expect(
          PermissionNext.evaluate("parse_code", "*", (await Agent.get(PrimaryAgentIdentity.names.general)).permission)
            .action,
        ).toBe("deny")
      },
    }),
  )
})
