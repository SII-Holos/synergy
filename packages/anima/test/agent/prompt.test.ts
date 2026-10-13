import { expect, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { LLM, ToolResolver } from "@ericsanchezok/synergy-harness/test/support/internals"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { Session } from "@ericsanchezok/synergy-harness/session"
import type { Provider } from "@ericsanchezok/synergy-harness/provider/provider"
import { registerLocalRuntime } from "@ericsanchezok/synergy-local-runtime/register"
import { library } from "@ericsanchezok/synergy-library/component"
import { agenda } from "@ericsanchezok/synergy-agenda/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { anima } from "../../src/component"
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

for (const selected of [false, true]) {
  for (const denied of [false, true]) {
    test(`anima prompt follows owner selection and actual tool permissions (${selected}, ${denied})`, async () => {
      await using runtime = await testRuntime({
        env: {
          SYNERGY_CONFIG_CONTENT: JSON.stringify({
            library: { experience: { retrieve: false, encode: false } },
            agent: selected
              ? { anima: { permission: denied ? { "memory_*": "deny", "note_*": "deny", "agenda_*": "deny" } : {} } }
              : {},
          }),
        },
        composition: {
          register() {
            registerLocalRuntime()
            if (selected) {
              library().register()
              agenda().register()
              note().register()
              anima().register()
            }
          },
        },
      })
      await runtime.run(() =>
        ScopeContext.provide({
          scope: Scope.home(),
          fn: async () => {
            const agent = (await Agent.list()).find((agent) => agent.name === "anima")
            if (!selected) {
              expect(agent).toBeUndefined()
              return
            }
            expect(agent).toBeDefined()
            if (!agent) throw new Error("Missing owner agent")
            const session = await Session.create({ title: "Owner prompt" })
            const availability = await ToolResolver.availability({
              agent,
              model,
              sessionID: session.id,
              includeMCP: false,
            })
            const availableToolIDs = [
              ...availability.visible.filter((tool) => !availability.diagnostics.has(tool.id)).map((tool) => tool.id),
              ...availability.autoExpandable,
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
              system: [],
              messages: [],
              abort: new AbortController().signal,
            })
            const prompt = prepared.system.join("\n")
            expect(prompt).not.toMatch(
              /Feishu|飞书|lark-cli|mcp__anysearch__search|community presence|community state/i,
            )
            if (denied) {
              expect(availableToolIDs).not.toContain("memory_write")
              expect(availableToolIDs).not.toContain("agenda_schedule")
              expect(prompt).not.toMatch(
                /memory_(?:search|get|write|edit)|note_(?:read|write|edit|list|search)|agenda_(?:schedule|watch|list|logs|cancel|update)/,
              )
            } else {
              expect(availableToolIDs).toContain("memory_write")
              expect(availableToolIDs).toContain("agenda_schedule")
              expect(prompt).toContain("memory_write")
              expect(prompt).toContain("agenda_schedule")
              expect(prompt).toContain("Daily: YYYY-MM-DD")
            }
          },
        }),
      )
    }, 20_000)
  }
}
