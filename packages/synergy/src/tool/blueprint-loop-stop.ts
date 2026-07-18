import z from "zod"
import { AgendaSessionWakeup } from "../agenda/session-wakeup"
import { BlueprintLoopStore, LoopError } from "../blueprint"
import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import DESCRIPTION from "./blueprint-loop-stop.txt"
import { Tool } from "./tool"

const parameters = z.object({
  summary: z.string().describe("Summary of what was completed."),
  completed: z.array(z.string()).optional().describe("Completed Blueprint requirement statements."),
  evidence: z
    .array(z.string())
    .optional()
    .describe("Concrete verification evidence such as checks, artifacts, and file paths."),
  remaining: z.array(z.string()).optional().describe("Any known remaining work or limitations."),
})

export const BlueprintLoopStopTool = Tool.define("blueprint_loop_stop", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const session = await Session.get(ctx.sessionID)
    const loopID = session.blueprint?.loopID
    if (!loopID || session.blueprint?.loopRole !== "execution") {
      throw new Error("Only the BlueprintLoop execution session may request review")
    }

    const scopeID = ScopeContext.current.scope.id
    const loop = await BlueprintLoopStore.get(scopeID, loopID).catch(() => {
      throw new LoopError.NotFound({ id: loopID })
    })
    if (loop.sessionID !== ctx.sessionID) {
      throw new Error("Only the BlueprintLoop execution session may request review")
    }

    if (loop.stopRequest) {
      const reviewSessionID = loop.auditSessionID
      return {
        title: "BlueprintLoop review already requested",
        output: reviewSessionID
          ? `A review was already requested for this BlueprintLoop. The reviewer is session \`${reviewSessionID}\`. Do not call any tools to check on it — the reviewer will deliver results directly to this session when the audit completes.`
          : "A review was already requested for this BlueprintLoop. The reviewer will start after the current session turn finishes.",
        metadata: {
          loopStopRequested: true,
          reviewTaskID: loop.auditTaskID,
          reviewSessionID,
        },
      }
    }
    if (loop.status !== "running") {
      throw new Error(`Cannot request review for BlueprintLoop ${loop.id} while its status is "${loop.status}"`)
    }

    const summary = params.summary.trim()
    if (!summary) throw new Error("summary is required")
    await AgendaSessionWakeup.assertClear({
      sessionID: ctx.sessionID,
      scopeID,
      operation: "BlueprintLoop audit",
    })
    await BlueprintLoopStore.recordStopRequest(scopeID, loop.id, {
      summary,
      completed: params.completed,
      evidence: params.evidence,
      remaining: params.remaining,
      requestedAt: Date.now(),
      requesterSessionID: ctx.sessionID,
      requesterMessageID: ctx.messageID,
    })

    return {
      title: "BlueprintLoop review requested",
      output: "BlueprintLoop stop review requested. The reviewer will start after the current session turn finishes.",
      metadata: { loopStopRequested: true, reviewTaskID: undefined, reviewSessionID: undefined },
    }
  },
})
