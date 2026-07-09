import { expect, test } from "bun:test"
import { createBuiltinMaxSubagents } from "../../src/agent/builtin-max-subagents"
import { AgentDelegation } from "../../src/agent/delegation"
import { getDelegatableAgents } from "../../src/agent/prompt/agent-table"

const ctx = {
  defaults: [],
  user: [],
  role: () => undefined,
  evolutionActive: false,
}

test("hidden recursive reviewer agents stay off primary tables but can delegate through groups", () => {
  const agents = createBuiltinMaxSubagents(ctx)
  const supervisor = agents["supervisor"]
  const reviewer = agents["lightloop-reviewer"]
  expect(supervisor, "supervisor agent should exist").toBeDefined()
  expect(reviewer, "lightloop-reviewer agent should exist").toBeDefined()
  expect(supervisor.hidden, "supervisor must be marked hidden").toBe(true)
  expect(reviewer.hidden, "lightloop-reviewer must be marked hidden").toBe(true)
  expect(supervisor.visibleTo, "supervisor must only be visible to itself").toEqual(["supervisor"])
  expect(reviewer.visibleTo, "lightloop-reviewer must only be visible to itself").toEqual(["lightloop-reviewer"])
  expect(reviewer.delegationGroups).toEqual(["supervisor"])

  const asAgentInfo = (a: (typeof agents)[string]) => ({
    name: a.name,
    description: a.description ?? "",
    mode: a.mode,
    hidden: a.hidden,
    visibleTo: a.visibleTo,
    delegationGroups: a.delegationGroups,
  })
  const agentInfos = Object.values(agents).map(asAgentInfo)

  const synergyMaxDelegatable = getDelegatableAgents(agentInfos, "synergy-max")
  const synergyDelegatable = getDelegatableAgents(agentInfos, "synergy")
  const namesForMax = synergyMaxDelegatable.map((a) => a.name)
  const namesForSynergy = synergyDelegatable.map((a) => a.name)
  expect(namesForMax).not.toContain("supervisor")
  expect(namesForMax).not.toContain("lightloop-reviewer")
  expect(namesForSynergy).not.toContain("supervisor")
  expect(namesForSynergy).not.toContain("lightloop-reviewer")
  expect(namesForMax.length, "non-hidden subagents should still be present").toBeGreaterThan(0)

  const reviewerDelegatable = getDelegatableAgents(agentInfos, asAgentInfo(reviewer))
  const reviewerNames = reviewerDelegatable.map((a) => a.name)
  expect(reviewerNames).toContain("implementation-engineer")
  expect(reviewerNames).toContain("quality-gatekeeper")
  expect(reviewerNames).not.toContain("supervisor")
  expect(reviewerNames).not.toContain("lightloop-reviewer")
  expect(AgentDelegation.canDelegateTo(agents["implementation-engineer"], undefined)).toBe(false)

  for (const caller of ["synergy", "synergy-max"]) {
    for (const agent of [supervisor, reviewer]) {
      const isVisible = !agent.visibleTo || agent.visibleTo.length === 0 || agent.visibleTo.includes(caller)
      expect(isVisible, `${agent.name} must not be visible to ${caller}`).toBe(false)
    }
  }
})
