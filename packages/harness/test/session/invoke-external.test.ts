import { describe, expect, test } from "bun:test"
import { AgentExternalSource } from "../../src/agent/external-source"
import { PROGRESS_UPDATES } from "../../src/agent/prompt/progress"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionExternalAgents } from "../../src/session/external-agents"
import { SessionInvoke } from "../../src/session/invoke"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

describe("SessionInvoke external permission mapping", () => {
  test("maps Claude Code control profile to bypass/default modes", () => {
    const fullAccessConfig = SessionInvoke.applyExternalPermissionMode({}, "claude-code", "full_access")
    expect(fullAccessConfig.controlProfile).toBe("full_access")
    expect(fullAccessConfig.permissionMode).toBe("bypassPermissions")
    expect(fullAccessConfig.skipPermissions).toBeUndefined()

    const guardedConfig = SessionInvoke.applyExternalPermissionMode({ skipPermissions: true }, "claude-code", "guarded")
    expect(guardedConfig.controlProfile).toBe("guarded")
    expect(guardedConfig.permissionMode).toBe("default")
    expect(guardedConfig.skipPermissions).toBeUndefined()
  })

  test("passes control profile through to Codex without approval policy", () => {
    const fullAccessConfig = SessionInvoke.applyExternalPermissionMode({}, "codex", "full_access")
    expect(fullAccessConfig.controlProfile).toBe("full_access")
    expect(fullAccessConfig.approvalPolicy).toBeUndefined()

    const guardedConfig = SessionInvoke.applyExternalPermissionMode({}, "codex", "guarded")
    expect(guardedConfig.controlProfile).toBe("guarded")
    expect(guardedConfig.approvalPolicy).toBeUndefined()
  })
})

for (const scenario of [
  { name: "native Codex model", adapter: "codex", configured: "gpt-5", selected: "deepseek-chat", expected: 1 },
  { name: "native Codex default", adapter: "codex", configured: undefined, selected: "deepseek-chat", expected: 1 },
  {
    name: "incompatible override",
    adapter: "claude-code",
    configured: "claude-sonnet-4-5",
    selected: "deepseek-chat",
    expected: 1,
  },
  { name: "configured DeepSeek", adapter: "claude-code", configured: "deepseek-chat", selected: "gpt-5", expected: 0 },
  {
    name: "applied alias metadata",
    adapter: "claude-code",
    configured: "claude-sonnet-4-5",
    selected: "opaque",
    family: "deepseek",
    anthropic: true,
    expected: 0,
  },
  {
    name: "unsupported model switch",
    adapter: "claude-code",
    configured: "claude-sonnet-4-5",
    selected: "deepseek-chat",
    anthropic: true,
    modelSwitch: false,
    expected: 1,
  },
]) {
  test(`external progress guidance follows the executed model: ${scenario.name}`, async () => {
    const calls: SessionExternalAgents.ProcessInput[] = []
    let configuredModel: unknown
    const adapter: SessionExternalAgents.Adapter = {
      name: scenario.adapter,
      started: false,
      capabilities: { modelSwitch: scenario.modelSwitch ?? true },
      async start({ config }) {
        configuredModel = config.model
      },
    }
    await using runtime = await testRuntime({
      env: {
        SYNERGY_CONFIG_CONTENT: JSON.stringify({
          model: "fixture/alias",
          provider: {
            fixture: {
              npm: scenario.anthropic ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
              env: [],
              options: { apiKey: "fixture", baseURL: "https://example.invalid" },
              models: {
                alias: { id: scenario.selected, family: scenario.family, limit: { context: 128000, output: 8000 } },
              },
            },
          },
          agent: { fixture: { mode: "all", prompt: "Preserve this external Agent instruction." } },
        }),
      },
      register() {
        AgentExternalSource.register({
          async loadAdapters() {},
          description: () => "Fixture external Agent",
          async discover() {
            return new Map([
              [
                "fixture",
                {
                  adapter: scenario.adapter,
                  config: { model: scenario.configured, nativeAuth: scenario.adapter === "codex" },
                },
              ],
            ])
          },
        })
        SessionExternalAgents.register({
          getAdapter: () => adapter,
          async process(input) {
            calls.push(input)
            await Session.updateMessage({
              id: Identifier.ascending("message"),
              sessionID: input.sessionID,
              parentID: input.parentID,
              rootID: input.parentID,
              role: "assistant",
              agent: "fixture",
              mode: "fixture",
              modelID: input.model.modelID,
              providerID: input.model.providerID,
              path: { cwd: null, root: null },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              finish: "stop",
              time: { created: Date.now(), completed: Date.now() },
            })
          },
        })
      },
    })
    await runtime.run(async () => {
      await using tmp = await tmpdir({ git: true })
      await ScopeContext.provide({
        scope: await tmp.scope(),
        async fn() {
          const session = await Session.create({ title: "External progress fixture" })
          await SessionInvoke.invoke({
            sessionID: session.id,
            agent: "fixture",
            parts: [{ type: "text", text: "Complete this task." }],
          })
          expect(calls).toHaveLength(1)
          expect(configuredModel).toBe(
            scenario.anthropic && scenario.modelSwitch !== false ? scenario.selected : scenario.configured,
          )
          const instructions = calls[0]!.context.instructions!
          expect(instructions).toContain("Preserve this external Agent instruction.")
          expect(instructions.split(PROGRESS_UPDATES).length - 1).toBe(scenario.expected)
        },
      })
    })
  })
}
