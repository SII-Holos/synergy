import { expect, test } from "bun:test"
import path from "node:path"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { ConfigDomain } from "@ericsanchezok/synergy-harness/config/domain"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { SessionPluginHooks } from "@ericsanchezok/synergy-harness/session/plugin-hooks"
import { testRuntime as coreRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { registerLibrary, disposeLibrary } from "../src/register"
import { LibraryDB } from "../src/database"
import { testRuntime } from "./support/runtime"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { ConfigSource } from "@ericsanchezok/synergy-harness/config/source"
import { PermissionNext } from "@ericsanchezok/synergy-harness/permission/next"
import { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { LLM } from "@ericsanchezok/synergy-harness/test/support/internals"

for (const selected of [false, true]) {
  test(`Library memory semantics follow actual composition without tool tutorials (${selected})`, async () => {
    await using runtime = await coreRuntime({
      composition: {
        register() {
          if (selected) registerLibrary()
          ConfigSource.register({
            resolve: async () => ({
              provider: { openai: { options: { apiKey: "fixture-key" } } },
              agent: Object.fromEntries(
                [PrimaryAgentIdentity.names.general, "developer", "scribe", "scholar"].map((name) => [
                  name,
                  { permission: { "memory_*": "allow" } },
                ]),
              ),
            }),
          })
        },
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const model = await Provider.getModel("openai", "gpt-4o")
          const ids = await ToolRegistry.ids()
          expect(ids.includes("memory_write")).toBe(selected)
          for (const name of [PrimaryAgentIdentity.names.general, "developer", "scribe", "scholar"]) {
            const agent = await Agent.get(name)
            const availableToolIDs = ids.filter(
              (id) => PermissionNext.evaluate(id, "*", agent.permission).action !== "deny",
            )
            const prepared = await LLM.prepare({
              agent,
              model,
              sessionID: "ses_memory_prompt",
              tools: {},
              availableToolIDs,
              user: {
                id: "msg_memory_prompt",
                sessionID: "ses_memory_prompt",
                role: "user",
                time: { created: Date.now() },
                agent: agent.name,
                model: { providerID: model.providerID, modelID: model.id },
              },
              system: [],
              messages: [],
              abort: new AbortController().signal,
            })
            const prompt = prepared.system.join("\n")
            const contributions = AgentPromptContributions.render(agent, new Set(availableToolIDs))
            expect(contributions).toHaveLength(selected ? 1 : 0)
            for (const contribution of contributions) expect(prompt).toContain(contribution)
            expect(prompt).not.toMatch(/When to `memory_|Prefer `memory_edit`|Search before writing/)
            if (selected) {
              expect(prompt).toContain("Respect privacy and consent limits")
              expect(prompt).toContain("require explicit approval")
              expect(prompt).toContain("intended recipient, channel, and content")
              expect(prompt).toContain("never claim a memory was saved without confirmation")
              expect(AgentPromptContributions.render(agent, new Set())).toEqual([])
            }
          }
          const chronicler = (await Agent.list()).find((agent) => agent.name === "chronicler")
          expect(!!chronicler).toBe(selected)
          if (chronicler) {
            expect(chronicler.prompt).toContain("Ground behavioral self-knowledge in observed actions")
            expect(chronicler.prompt).toContain("never store secrets")
            expect(chronicler.prompt).toContain("Preserve uniquely useful details")
            expect(chronicler.prompt).toContain("if preservation fails, leave the original intact")
            expect(chronicler.prompt).toContain("concurrent changes")
            expect(chronicler.prompt).toContain("Always finish with a brief text response")
            expect(chronicler.prompt).not.toMatch(/memory_search|memory_edit|memory_write|`read`|`grep`|`glob`/)
          }
        },
      }),
    )
  })
}

test("library composes independently without product registration or plugin delivery", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    registerLibrary()
    registerLibrary()
    expect(MigrationRegistry.list().has("library")).toBe(true)
    expect(ToolRegistry.toolProviderIDs().filter((id) => id === "library")).toHaveLength(1)
    for (const key of ["channel", "plugin", "voice", "mcp"]) expect(key in Config.Info.shape).toBe(false)
    const initial = { results: ["unchanged"] }
    expect(await SessionPluginHooks.trigger("library.search.after", {}, initial)).toBe(initial)
    expect(await SessionPluginHooks.installed()).toEqual([])
  })
})

test("Library disposal closes its database after operations and can repeat", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const connection = LibraryDB.connection()
    expect(connection.query("SELECT 1 AS value").get()).toEqual({ value: 1 })
    await disposeLibrary()
    expect(() => connection.query("SELECT 1").get()).toThrow()
    await disposeLibrary()
  })
})

test("late Library registration cannot partially register config or change dormant data", async () => {
  await using fixture = await runtimeHome()
  const files = [
    path.join(fixture.host.root, "config/50-library.jsonc"),
    path.join(fixture.host.root, "data/library/absent-owner.json"),
  ]
  const dormant = JSON.stringify({ futureOwnerField: { revision: 42 } })
  for (const file of files) await Bun.write(file, dormant)
  await using runtime = await coreRuntime({ home: fixture.host.home, composition: { register() {} } })
  await runtime.run(async () => {
    expect("library" in Config.Info.shape).toBe(false)
    expect(registerLibrary).toThrow(/before opening/i)
    expect(registerLibrary).toThrow(/before opening/i)
    for (const field of ["library", "embedding", "rerank"]) expect(field in Config.Info.shape).toBe(false)
    expect(ConfigDomain.byId().has("library")).toBe(false)
    expect(MigrationRegistry.list().has("library")).toBe(false)
    for (const file of files) expect(await Bun.file(file).text()).toBe(dormant)
  })
})
