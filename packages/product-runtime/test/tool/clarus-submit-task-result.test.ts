import { expect, test } from "bun:test"
import { Channel } from "@ericsanchezok/synergy-connections/channel"
import { ChannelHost } from "@ericsanchezok/synergy-connections/channel/host"
import type { RuntimeTaskAssignedEvent } from "@ericsanchezok/synergy-connections/channel/provider/clarus/agent-tunnel-port"
import { ClarusAssignmentRuntime } from "@ericsanchezok/synergy-connections/channel/provider/clarus/assignment-runtime"
import { ClarusProvider } from "@ericsanchezok/synergy-connections/channel/provider/clarus"
import { ClarusSubmitTaskResultTool } from "@ericsanchezok/synergy-connections/channel/tools/clarus-submit-task-result"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

// Product domains register tools via the L4 manifest
import "@ericsanchezok/synergy-product-runtime/product-registration"

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

test("Clarus result tool sanitizes rejected upstream codes", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const accountId = "result-tool-rejection-account"
      const projectID = "result-tool-rejection-project"
      await Channel.ensureProjectScope({
        channelType: "clarus",
        accountId,
        externalProjectId: projectID,
        projectName: `Project ${projectID}`,
      })
      const event: RuntimeTaskAssignedEvent = {
        kind: "known",
        type: "runtimeTaskAssigned",
        agentID: accountId,
        requestID: crypto.randomUUID(),
        projectID,
        runID: "result-tool-rejection-run",
        taskID: "result-tool-rejection-task",
        phase: "implementation",
        subtaskID: "result-tool-rejection-subtask",
        attempt: 1,
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        epoch: 1,
        generation: 1,
      }
      const created = await ClarusAssignmentRuntime.dispatch({
        host: ChannelHost.create({ channelType: "clarus", accountId }),
        accountId,
        event,
      })
      const previous = Channel.getProvider("clarus")
      const provider = new ClarusProvider()
      ;(provider as unknown as { submitTaskResult: () => Promise<never> }).submitTaskResult = async () => {
        throw {
          disposition: "rejected",
          requestID: "result-tool-rejected",
          code: "INVALID CODE !!!",
          message: "invalid result",
        }
      }
      Channel.registerProvider(provider)

      try {
        const tool = await ClarusSubmitTaskResultTool.init()
        const context = {
          sessionID: created.assignment.sessionID,
          messageID: `msg_${crypto.randomUUID()}`,
          agent: "synergy",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        } as Tool.Context

        await expect(tool.execute({ success: true, output: "done" }, context)).rejects.toMatchObject({
          code: "INVALID_CODE____",
          disposition: "rejected",
          requestID: "result-tool-rejected",
        })
      } finally {
        if (previous) Channel.registerProvider(previous)
      }
    },
  })
})
