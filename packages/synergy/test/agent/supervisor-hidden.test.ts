import { expect, test } from "bun:test"
import { createBuiltinMaxSubagents } from "../../src/agent/builtin-max-subagents"
import { getDelegatableAgents } from "../../src/agent/prompt/agent-table"
import { ScopeContext } from "../../src/scope/context"
import { TaskTool } from "../../src/tool/task"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  defaults: [],
  user: [],
  role: () => undefined,
  evolutionActive: false,
}

test("supervisor is hidden and invisible to all primaries except itself", () => {
  const agents = createBuiltinMaxSubagents(ctx)
  const supervisor = agents["supervisor"]
  expect(supervisor, "supervisor agent should exist").toBeDefined()
  expect(supervisor.hidden, "supervisor must be marked hidden").toBe(true)
  expect(supervisor.visibleTo, "supervisor must only be visible to itself").toEqual(["supervisor"])

  const asAgentInfo = (a: (typeof agents)[string]) => ({
    name: a.name,
    description: a.description ?? "",
    mode: a.mode,
    hidden: a.hidden,
    visibleTo: a.visibleTo,
  })

  // Description-level: hidden: true excludes supervisor from all primary agent tables.
  const synergyMaxDelegatable = getDelegatableAgents(Object.values(agents).map(asAgentInfo), "synergy-max")
  const synergyDelegatable = getDelegatableAgents(Object.values(agents).map(asAgentInfo), "synergy")
  const namesForMax = synergyMaxDelegatable.map((a) => a.name)
  const namesForSynergy = synergyDelegatable.map((a) => a.name)
  expect(namesForMax).not.toContain("supervisor")
  expect(namesForSynergy).not.toContain("supervisor")
  expect(namesForMax.length, "non-hidden subagents should still be present").toBeGreaterThan(0)

  // Execution-time defense-in-depth: even if `hidden` were bypassed, the
  // narrowed visibleTo blocks every primary from calling task("supervisor", …).
  for (const caller of ["synergy", "synergy-max"]) {
    const isVisible =
      !supervisor.visibleTo || supervisor.visibleTo.length === 0 || supervisor.visibleTo.includes(caller)
    expect(isVisible, `supervisor must not be visible to ${caller}`).toBe(false)
  }
})

test("task tool refuses hidden supervisor even when called directly", async () => {
  await using tmp = await tmpdir({ git: true })

  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const tool = await TaskTool.init()

      await expect(
        tool.execute(
          {
            description: "audit directly",
            prompt: "Audit this loop",
            subagent_type: "supervisor",
          },
          {
            sessionID: "ses_exec",
            messageID: "msg_exec",
            agent: "synergy",
            abort: new AbortController().signal,
            ask: async () => {},
            metadata: () => {},
          },
        ),
      ).rejects.toThrow("internal and cannot be called with the task tool")
    },
  })
})
