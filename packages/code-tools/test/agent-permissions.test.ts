import { expect, test } from "bun:test"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { ConfigSource } from "@ericsanchezok/synergy-harness/config/source"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerAgentPermissions } from "../src/agent-permissions"
import { codeTools } from "../src/component"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"
import { LLM } from "@ericsanchezok/synergy-harness/test/support/internals"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"

for (const selected of [false, true]) {
  for (const denied of [false, true]) {
    test(`code tools retain grants without prompt tutorials (${selected}, ${denied})`, async () => {
      await using runtime = await testRuntime({
        composition: {
          register() {
            registerLocalRuntime()
            if (selected) codeTools().register()
          },
        },
        register() {
          ConfigSource.register({
            resolve: async () => ({
              provider: { openai: { options: { apiKey: "fixture-key" } } },
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
            expect(PermissionNext.evaluate("parse_code", "*", agent.permission).action).toBe(denied ? "deny" : "allow")
            expect((await ToolRegistry.ids()).includes("parse_code")).toBe(selected)
            expect(AgentPromptContributions.render(agent, available)).toEqual([])
            expect(AgentPromptContributions.render(agent, new Set())).toEqual([])
            const model = await Provider.getModel("openai", "gpt-4o")
            const prepared = await LLM.prepare({
              agent,
              model,
              sessionID: "ses_code_prompt",
              tools: {},
              availableToolIDs: [...available],
              user: {
                id: "msg_code_prompt",
                sessionID: "ses_code_prompt",
                role: "user",
                time: { created: Date.now() },
                agent: agent.name,
                model: { providerID: model.providerID, modelID: model.id },
              },
              system: [],
              messages: [],
              abort: new AbortController().signal,
            })
            expect(prepared.system.join("\n")).not.toMatch(/Use parse_code|AST-aware structural search/)
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
