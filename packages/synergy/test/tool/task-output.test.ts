import { describe, expect, test } from "bun:test"
import { TaskOutputTool } from "../../src/tool/task-output"

describe("task_output parameters", () => {
  test("allows blocking only for full result retrieval", async () => {
    const tool = await TaskOutputTool.init()

    expect(tool.parameters.safeParse({ task_id: "ctx_test", block: true }).success).toBe(true)
    expect(tool.parameters.safeParse({ task_id: "ctx_test", mode: "full", block: true }).success).toBe(true)

    for (const mode of ["summary", "progress", "tail"] as const) {
      const result = tool.parameters.safeParse({ task_id: "ctx_test", mode, block: true })
      expect(result.success).toBe(false)
      if (!result.success) expect(result.error.issues[0]?.message).toContain("full")
    }
  })
})
