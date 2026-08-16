import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { ScopeContext } from "../../src/scope/context"
import { BatchTool } from "../../src/tool/batch"
import { TodoReadTool } from "../../src/tool/todo"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

function ctx(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: Identifier.ascending("message"),
    callID: "call-batch-test",
    agent: "synergy",
    abort: AbortSignal.any([]),
    metadata: () => {},
    ask: async () => {},
  }
}

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  return ScopeContext.provide({ scope, fn })
}

describe("batch tool", () => {
  test("validates that at least one tool call is required", async () => {
    const tool = await BatchTool.init()
    const result = tool.parameters.safeParse({ tool_calls: [] })
    expect(result.success).toBe(false)
  })

  test("rejects the batch tool itself as a nested call", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const tool = await BatchTool.init()
      const result = await tool.execute({ tool_calls: [{ tool: "batch", parameters: {} }] }, ctx(session.id))
      expect(result.metadata.failed).toBe(1)
      expect(result.metadata.successful).toBe(0)
    })
  })

  test("rejects unknown tools with a registry hint", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const tool = await BatchTool.init()
      const result = await tool.execute(
        { tool_calls: [{ tool: "definitely-not-a-tool", parameters: {} }] },
        ctx(session.id),
      )
      expect(result.metadata.failed).toBe(1)
      expect(result.metadata.details[0]).toEqual({ tool: "definitely-not-a-tool", success: false })
    })
  })

  test("runs registered tools in parallel and records session parts", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await TodoReadTool.init()
      const tool = await BatchTool.init()
      const result = await tool.execute(
        {
          tool_calls: [
            { tool: "todoread", parameters: {} },
            { tool: "todoread", parameters: {} },
          ],
        },
        ctx(session.id),
      )
      expect(result.metadata).toMatchObject({ totalCalls: 2, successful: 2, failed: 0 })
      expect(result.metadata.tools).toEqual(["todoread", "todoread"])
      expect(result.output).toContain("All 2 tools executed successfully")
    })
  })

  test("caps execution at ten calls and reports discarded calls as failures", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      await TodoReadTool.init()
      const tool = await BatchTool.init()
      const calls = Array.from({ length: 12 }, () => ({ tool: "todoread", parameters: {} }))
      const result = await tool.execute({ tool_calls: calls }, ctx(session.id))
      expect(result.metadata.totalCalls).toBe(12)
      expect(result.metadata.successful).toBe(10)
      expect(result.metadata.failed).toBe(2)
      expect(result.output).toContain("Executed 10/12 tools successfully")
    })
  })

  test("surfaces invalid parameters as per-call failures", async () => {
    await withScope(async () => {
      const session = await Session.create({})
      const { TodoWriteTool } = await import("../../src/tool/todo")
      await TodoWriteTool.init()
      const tool = await BatchTool.init()
      const result = await tool.execute({ tool_calls: [{ tool: "todowrite", parameters: {} }] }, ctx(session.id))
      expect(result.metadata.failed).toBe(1)
      expect(result.metadata.successful).toBe(0)
    })
  })
})
