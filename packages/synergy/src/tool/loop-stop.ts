import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { AgendaSessionWakeup } from "../agenda/session-wakeup"
import { ScopeContext } from "../scope/context"
import DESCRIPTION from "./loop-stop.txt"

const parameters = z.object({
  summary: z.string().describe("Summary of what was completed."),
  completed: z.array(z.string()).optional().describe("Completed deliverable or requirement statements."),
  evidence: z
    .array(z.string())
    .optional()
    .describe("Concrete verification evidence (test results, file paths, checks)."),
  remaining: z.array(z.string()).optional().describe("Any known remaining work or limitations."),
})

export const LoopStopTool = Tool.define("loop_stop", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const session = await Session.get(ctx.sessionID)
    if (session.workflow?.kind !== "lightloop") {
      throw new Error("No active Light Loop workflow on this session")
    }

    const summary = params.summary.trim()
    if (!summary) throw new Error("summary is required")

    if (session.workflow.stopRequest) {
      const reviewSessionID = session.workflow.stopRequest.reviewSessionID
      return {
        title: "Light Loop review already requested",
        output: reviewSessionID
          ? `A review was already requested for this Light Loop task. The reviewer is session \`${reviewSessionID}\`. Do not call any tools to check on it — the reviewer will deliver results directly to this session when the audit completes.`
          : "A review was already requested for this Light Loop task. The reviewer will start after the current session turn finishes.",
        metadata: {
          loopStopRequested: true,
          reviewTaskID: session.workflow.stopRequest.reviewTaskID,
          reviewSessionID,
        },
      }
    }
    await AgendaSessionWakeup.assertClear({
      sessionID: ctx.sessionID,
      scopeID: ScopeContext.current.scope.id,
      operation: "Light Loop review",
    })

    const requestedAt = Date.now()
    let stopRequestRecorded = false
    await Session.update(ctx.sessionID, (draft) => {
      if (draft.workflow?.kind !== "lightloop" || draft.workflow.stopRequest) return
      draft.workflow = {
        ...draft.workflow,
        stopRequest: {
          summary,
          completed: params.completed,
          evidence: params.evidence,
          remaining: params.remaining,
          requestedAt,
          requesterSessionID: ctx.sessionID,
          requesterMessageID: ctx.messageID,
        },
      }
      stopRequestRecorded = true
    })

    if (!stopRequestRecorded) {
      const latest = await Session.get(ctx.sessionID)
      if (latest.workflow?.kind !== "lightloop" || !latest.workflow.stopRequest) {
        throw new Error("Failed to record Light Loop stop request")
      }
    }

    return {
      title: "Light Loop review requested",
      output: "Light Loop stop review requested. The reviewer will start after the current session turn finishes.",
      metadata: { loopStopRequested: true, reviewTaskID: undefined, reviewSessionID: undefined },
    }
  },
})
