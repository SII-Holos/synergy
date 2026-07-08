import { expect, test } from "bun:test"
import { createBuiltinMaxSubagents } from "../../src/agent/builtin-max-subagents"
import { getDelegatableAgents } from "../../src/agent/prompt/agent-table"

const ctx = {
  defaults: [],
  user: [],
  role: () => undefined,
  evolutionActive: false,
}

test("supervisor is hidden and excluded from delegated agent listings", () => {
  const agents = createBuiltinMaxSubagents(ctx)
  const supervisor = agents["supervisor"]
  expect(supervisor, "supervisor agent should exist").toBeDefined()
  expect(supervisor.hidden, "supervisor must be marked hidden").toBe(true)

  const agentInfos = Object.values(agents).map((a) => ({
    name: a.name,
    description: a.description ?? "",
    mode: a.mode,
    hidden: a.hidden,
    visibleTo: a.visibleTo,
  }))

  const delegatable = getDelegatableAgents(agentInfos, "synergy-max")
  const names = delegatable.map((a) => a.name)

  expect(names, "supervisor should not appear in synergy-max delegatable agents").not.toContain("supervisor")
  expect(names.length, "non-hidden subagents should still be present").toBeGreaterThan(0)
})
