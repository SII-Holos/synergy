import { expect, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { LLM, ToolResolver } from "@ericsanchezok/synergy-harness/test/support/internals"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionEndpoint } from "@ericsanchezok/synergy-harness/session/endpoint"
import { SessionExecutionContributions } from "@ericsanchezok/synergy-harness/session/execution-contributions"
import { WorkflowPromptRegistry } from "@ericsanchezok/synergy-harness/session/workflow-prompt-registry"
import type { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { library } from "@ericsanchezok/synergy-library/component"
import { agenda } from "@ericsanchezok/synergy-agenda/component"
import { boss } from "@ericsanchezok/synergy-boss/component"
import { WorkflowSessionService } from "@ericsanchezok/synergy-boss/session/workflow"
import { channels } from "@ericsanchezok/synergy-channels/component"
import { channelFeishu } from "@ericsanchezok/synergy-channel-feishu/component"
import { bossFeishu } from "../src/component"
const model: Provider.Model = {
  id: "fixture",
  providerID: "fixture",
  name: "Fixture",
  family: "fixture",
  api: { id: "fixture", url: "https://example.invalid", npm: "@ai-sdk/openai" },
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, output: 8192 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

for (const selected of [false, true])
  for (const denied of [false, true])
    for (const channel of [false, true]) {
      test(`Feishu delivery guidance follows bridge selection and callable tools (${selected}, ${denied}, ${channel})`, async () => {
        await using runtime = await testRuntime({
          env: {
            SYNERGY_CONFIG_CONTENT: JSON.stringify({
              library: { experience: { retrieve: false, encode: false } },
              agent: { "boss-synergy": { permission: denied ? { channel_push: "deny" } : {} } },
            }),
          },
          composition: {
            register() {
              registerLocalRuntime()
              library().register()
              agenda().register()
              boss().register()
              channels().register()
              channelFeishu().register()
              if (selected) bossFeishu().register()
            },
          },
        })
        await runtime.run(() =>
          ScopeContext.provide({
            scope: Scope.home(),
            fn: async () => {
              const agent = await Agent.get("boss-synergy")
              const created = await Session.create({
                title: "Boss delivery",
                ...(channel
                  ? { endpoint: SessionEndpoint.fromChannel({ type: "feishu", accountId: "fixture", chatId: "boss" }) }
                  : {}),
              })
              await WorkflowSessionService.enableBoss(created.id)
              const session = await Session.get(created.id)
              const availability = await ToolResolver.availability({
                agent,
                model,
                sessionID: session.id,
                session,
                includeMCP: false,
              })
              const availableToolIDs = [
                ...availability.visible.filter((tool) => !availability.diagnostics.has(tool.id)).map((tool) => tool.id),
                ...availability.autoExpandable,
              ]
              const context = {
                agentName: agent.name,
                toolIDs: availableToolIDs,
                deliveryMetadata: {
                  channelPush: true,
                  channelChatId: "chat_target",
                  channelReplyToMessageId: "message_target",
                },
              }
              const system = [
                ...(await WorkflowPromptRegistry.get("boss")!.buildSystem!(session, context)),
                ...(await SessionExecutionContributions.system(session, context)),
              ]
              const prepared = await LLM.prepare({
                agent,
                model,
                sessionID: session.id,
                tools: {},
                availableToolIDs,
                user: {
                  id: "msg_owner_prompt",
                  sessionID: session.id,
                  role: "user",
                  time: { created: Date.now() },
                  agent: agent.name,
                  model: { providerID: model.providerID, modelID: model.id },
                },
                system,
                messages: [],
                abort: new AbortController().signal,
              })
              const prompt = prepared.system.join("\n")
              const enabled = selected && !denied && channel
              expect(availableToolIDs.includes("channel_push")).toBe(enabled)
              expect(prompt.includes("<boss-delivery>")).toBe(enabled)
              expect(prompt.includes("chat_target")).toBe(enabled)
              expect(prompt.includes("message_target")).toBe(enabled)
              expect(prompt.includes("Feishu source headers")).toBe(enabled)
              expect(prompt.includes("Feishu history requires authorized read access")).toBe(enabled)
              expect(prompt).not.toMatch(/lark-cli|auth status|im \+|channel_push\(/)
            },
          }),
        )
      }, 20_000)
    }
