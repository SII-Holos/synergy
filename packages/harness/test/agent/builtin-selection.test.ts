import { expect, test } from "bun:test"
import { PrimaryAgentIdentity } from "../../src/agent/primary-identity"
import { Agent } from "../../src/agent/agent"
import { AgentBuiltins } from "../../src/agent/builtins"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { testRuntime } from "../support/runtime"

test("an embedded host selects internal agents without product agent families", async () => {
  await using runtime = await testRuntime({
    register() {
      AgentBuiltins.selectDefaultFamilies(["internal"])
      AgentBuiltins.register("embedded", () => ({
        assistant: { name: "assistant", mode: "primary", permission: [], options: {}, native: true },
      }))
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const agents = await Agent.list()
        expect(agents.map((agent) => agent.name).sort()).toEqual([
          "agent-generator",
          "assistant",
          "compaction",
          "smart-allow",
          "summary",
          "title",
        ])
        expect(agents.filter((agent) => !agent.hidden).map((agent) => agent.name)).toEqual(["assistant"])
        expect(agents.find((agent) => agent.name === "assistant")!.permission).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ permission: "memory_write" })]),
        )
        expect(() => AgentBuiltins.selectDefaultFamilies([])).toThrow("before opening the Runtime")
        expect(() => AgentBuiltins.register("late", () => ({}))).toThrow("before opening the Runtime")
      },
    }),
  )
})

test("default agent family selection is isolated between runtimes", async () => {
  await using selected = await testRuntime({ register: () => AgentBuiltins.selectDefaultFamilies([]) })
  await using product = await testRuntime()
  const names = (runtime: typeof selected) =>
    runtime.run(() =>
      ScopeContext.provide({ scope: Scope.home(), fn: async () => (await Agent.list()).map((agent) => agent.name) }),
    )
  expect(await names(selected)).toEqual([])
  expect(await names(product)).toContain(PrimaryAgentIdentity.names.general)
  expect(await names(product)).toContain("compaction")
})

test("core agent catalogs do not promise or grant absent product capabilities", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const agents = await Agent.list()
        for (const name of ["supervisor", "lightloop-reviewer", "boss-synergy", "chronicler", "anima"])
          expect(agents.some((agent) => agent.name === name)).toBe(false)
        for (const agent of agents) {
          expect(agent.prompt ?? "").not.toMatch(
            /\b(?:memory_|note_|agenda_|mcp__|blueprint_loop_)|\b(?:parse_code|scan_document|look_at)\b|`(?:render|diagram)`/,
          )
          expect(agent.prompt ?? "").not.toMatch(/Feishu|Holos/)
          expect(
            agent.permission.some((rule) =>
              /^(memory|note|agenda|blueprint_loop|browser)_|^(parse_code|ast_grep|scan_document)$/.test(
                rule.permission,
              ),
            ),
          ).toBe(false)
        }
        for (const name of Object.values(PrimaryAgentIdentity.names))
          expect((await Agent.get(name)).prompt).toContain("General task help does not authorize")
      },
    }),
  )
})
