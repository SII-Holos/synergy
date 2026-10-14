import { expect, test } from "bun:test"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { ConfigSource } from "@ericsanchezok/synergy-harness/config/source"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { registerAgentPermissions } from "../src/agent-permissions"
import { media } from "../src/component"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"
import { LLM } from "@ericsanchezok/synergy-harness/test/support/internals"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"

for (const selected of [false, true]) {
  for (const denied of [false, true]) {
    test(`media tools retain grants without prompt tutorials (${selected}, ${denied})`, async () => {
      const tools = ["render", "scan_document", "look_at"]
      await using runtime = await testRuntime({
        composition: {
          register() {
            registerLocalRuntime()
            if (selected) media().register()
          },
        },
        register() {
          ConfigSource.register({
            resolve: async () => ({
              provider: { openai: { options: { apiKey: "fixture-key" } } },
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
            const ids = await ToolRegistry.ids()
            for (const tool of tools) {
              expect(PermissionNext.evaluate(tool, "*", agent.permission).action).toBe(denied ? "deny" : "allow")
              expect(ids.includes(tool)).toBe(selected)
            }
            expect(AgentPromptContributions.render(agent, available)).toEqual([])
            expect(AgentPromptContributions.render(agent, new Set())).toEqual([])
            const model = await Provider.getModel("openai", "gpt-4o")
            const prepared = await LLM.prepare({
              agent,
              model,
              sessionID: "ses_media_prompt",
              tools: {},
              availableToolIDs: [...available],
              user: {
                id: "msg_media_prompt",
                sessionID: "ses_media_prompt",
                role: "user",
                time: { created: Date.now() },
                agent: agent.name,
                model: { providerID: model.providerID, modelID: model.id },
              },
              system: [],
              messages: [],
              abort: new AbortController().signal,
            })
            expect(prepared.system.join("\n")).not.toMatch(/Use render|Use scan_document|Use look_at/)
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
