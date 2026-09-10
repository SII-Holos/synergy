import { describe, expect, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { AgentConfigTool } from "../../src/tools/agent-config"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

const ctx = {
  sessionID: "ses_agent_config_tool",
  messageID: "msg_agent_config_tool",
  callID: "call_agent_config_tool",
  agent: "synergy-max",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.agent_config", () => {
  test("create writes a markdown agent and the agent resolves", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await AgentConfigTool.init()
        const result = await tool.execute(
          {
            input: {
              action: "create",
              name: "doc-writer",
              description: "Writes documentation from code.",
              mode: "subagent",
              prompt: "You write documentation.",
            },
          },
          ctx,
        )

        expect(result.title).toContain("doc-writer")
        expect(result.metadata.action).toBe("create")
        expect(result.metadata.source).toBe("markdown")
        const agent = await Agent.get("doc-writer")
        expect(agent?.description).toBe("Writes documentation from code.")
      },
    })
  })

  test("update changes a field and preserves the rest", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await AgentConfigTool.init()
        await tool.execute(
          {
            input: {
              action: "create",
              name: "reviewer",
              description: "before",
              prompt: "Review code.",
              mode: "subagent",
            },
          },
          ctx,
        )
        const result = await tool.execute({ input: { action: "update", name: "reviewer", description: "after" } }, ctx)

        expect(result.metadata.action).toBe("update")
        const agent = await Agent.get("reviewer")
        expect(agent?.description).toBe("after")
        expect(agent?.prompt).toBe("Review code.")
      },
    })
  })

  test("create with an unresolved visibleTo reference is rejected with the offending name", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await AgentConfigTool.init()
        await expect(
          tool.execute(
            {
              input: {
                action: "create",
                name: "hidden-helper",
                prompt: "helper",
                visibleTo: ["typo-caller"],
              },
            },
            ctx,
          ),
        ).rejects.toThrow(/visibleTo.*typo-caller/)
      },
    })
  })

  test("set_default rejects a subagent-only target", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await AgentConfigTool.init()
        await expect(tool.execute({ input: { action: "set_default", name: "developer" } }, ctx)).rejects.toThrow(
          /primary/,
        )
      },
    })
  })

  test("remove with disable strategy writes disable and the agent disappears", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await AgentConfigTool.init()
        const result = await tool.execute({ input: { action: "remove", name: "explore" } }, ctx)

        expect(result.metadata.strategy).toBe("disable")
        expect(await Agent.get("explore")).toBeUndefined()
      },
    })
  })

  test("list returns built-in agents", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const tool = await AgentConfigTool.init()
        const result = await tool.execute({ input: { action: "list" } }, ctx)

        expect(result.metadata.count).toBeGreaterThan(0)
        expect(result.output).toContain("synergy")
      },
    })
  })

  test("parameters schema keeps an object root wrapping the action union", async () => {
    const tool = await AgentConfigTool.init()
    expect(tool.parameters.safeParse({ input: { action: "list" } }).success).toBe(true)
    expect(tool.parameters.safeParse({ action: "list" }).success).toBe(false)
  })
})
