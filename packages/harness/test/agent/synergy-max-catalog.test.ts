import { expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { AgentDelegation } from "../../src/agent/delegation"
import { buildSynergyMaxPrompt } from "../../src/agent/prompt/synergy-max/builder"
import { TaskTool } from "../../src/cortex/tools/task"
import { PermissionNext } from "../../src/permission/next"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"

test("max supplies complete specialist descriptions once through the permitted task catalog", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    async fn() {
      const caller = await Agent.get("synergy-max")
      expect(caller).toBeDefined()
      if (!caller) throw new Error("Missing primary agent")
      const agents = await Agent.list()
      const available = agents.filter((agent) => AgentDelegation.canDelegateTo(agent, caller))
      expect(available.length).toBeGreaterThan(0)
      const denied = available.find((agent) => agent.description && agent.description.length > 80)!
      expect(denied).toBeDefined()
      const agent = {
        ...caller,
        permission: PermissionNext.fromConfig({ task: { "*": "allow", [denied.name]: "deny" } }),
      }
      const tool = await TaskTool.init({ agent })
      const prompt = buildSynergyMaxPrompt(agents.map((item) => ({ ...item, description: item.description ?? "" })))
      const request = `${prompt}\n${tool.description}`

      expect(request).not.toContain(denied.description!)
      for (const item of available.filter((item) => item.name !== denied.name && item.description)) {
        expect(tool.description).toContain(`- ${item.name}: ${item.description}`)
        expect(request.split(item.description!).length - 1).toBe(1)
      }
    },
  })
})
