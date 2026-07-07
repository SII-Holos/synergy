import { expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

test("supervisor is hidden from delegated task agent listings", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const supervisor = await Agent.get("supervisor")
      expect(supervisor).toBeDefined()
      expect(supervisor?.hidden).toBe(true)

      const synergyMax = await Agent.get("synergy-max")
      const delegatedAgents = (await Agent.list()).filter(
        (agent: Agent.Info) =>
          agent.mode !== "primary" &&
          !agent.hidden &&
          (!synergyMax || !agent.visibleTo || agent.visibleTo.includes(synergyMax.name)),
      )
      expect(delegatedAgents.map((agent: Agent.Info) => agent.name)).not.toContain("supervisor")
    },
  })
})
