import { expect, test } from "bun:test"
import { ClarusSubmitTaskResultTool } from "../../src/tool/clarus-submit-task-result"
import { ToolRegistry } from "../../src/tool/registry"
import type { Tool } from "../../src/tool/tool"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

test("Clarus result tool rejects ordinary Sessions before provider access", async () => {
  await using tmp = await tmpdir()
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      expect(await ToolRegistry.find("clarus_submit_task_result")).toBeDefined()
      const tool = await ClarusSubmitTaskResultTool.init()
      const context = {
        sessionID: `ses_${crypto.randomUUID()}`,
        messageID: `msg_${crypto.randomUUID()}`,
        agent: "synergy",
        abort: new AbortController().signal,
        metadata() {},
        async ask() {},
      } as Tool.Context

      await expect(tool.execute({ success: true, output: "not an assignment" }, context)).rejects.toMatchObject({
        code: "CLARUS_TOOL_NOT_IN_ASSIGNMENT_SESSION",
      })
    },
  })
})
