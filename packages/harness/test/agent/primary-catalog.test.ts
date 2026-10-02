import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()
import { expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { AgentDelegation } from "../../src/agent/delegation"
import { buildSynergyPrompt } from "../../src/agent/prompt/synergy/builder"
import { buildSynergyMaxPrompt } from "../../src/agent/prompt/synergy-max/builder"
import { TaskTool } from "../../src/cortex/tools/task"
import { PermissionNext } from "../../src/permission/next"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"

const builders = { synergy: buildSynergyPrompt, "synergy-max": buildSynergyMaxPrompt }

for (const [name, buildPrompt] of Object.entries(builders)) {
  for (const denySpecialist of [false, true]) {
    test(`${name} supplies complete specialist descriptions once${denySpecialist ? " and excludes denied specialists" : ""}`, () =>
      runtime.run(async () => {
        await using tmp = await tmpdir()
        await ScopeContext.provide({
          scope: await tmp.scope(),
          async fn() {
            const caller = await Agent.get(name)
            expect(caller).toBeDefined()
            if (!caller) throw new Error("Missing primary agent")
            const agents = await Agent.list()
            const available = agents.filter((agent) => AgentDelegation.canDelegateTo(agent, caller))
            expect(available.length).toBeGreaterThan(0)
            const denied = denySpecialist
              ? available.find((agent) => agent.description && agent.description.length > 80)
              : undefined
            if (denySpecialist) expect(denied).toBeDefined()
            const agent = denied
              ? {
                  ...caller,
                  permission: PermissionNext.merge(
                    caller.permission,
                    PermissionNext.fromConfig({ task: { [denied.name]: "deny" } }),
                  ),
                }
              : caller
            const tool = await TaskTool.init({ agent })
            const prompt = buildPrompt(agents.map((item) => ({ ...item, description: item.description ?? "" })))
            const request = `${prompt}\n${tool.description}`

            if (denied) expect(request.includes(denied.description!)).toBe(false)
            for (const item of available.filter((item) => item.name !== denied?.name && item.description)) {
              expect(tool.description).toContain(`- ${item.name}: ${item.description}`)
              expect(request.split(item.description!).length - 1).toBe(1)
            }
          },
        })
      }))
  }
}

afterRuntimeTests(() => runtime.close())
