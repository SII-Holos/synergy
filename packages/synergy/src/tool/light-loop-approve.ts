import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { SessionWorkflowService } from "../session/workflow"
import { SessionManager } from "../session/manager"
import { Identifier } from "../id/id"
import DESCRIPTION from "./light-loop-approve.txt"

const parameters = z.object({
  sessionID: z.string().describe("The execution session ID provided in your launch context"),
  summary: z.string().describe("Concise approved completion verdict"),
})

export const LightLoopApproveTool = Tool.define("light_loop_approve", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const sessionID = params.sessionID
    const summary = params.summary.trim()
    if (!summary) throw new Error("summary is required")
    if (ctx.agent !== "lightloop-reviewer") {
      throw new Error("Only the lightloop-reviewer agent may approve Light Loop stop requests")
    }

    const target = await Session.get(sessionID)
    if (!target) throw new Error(`Session ${sessionID} not found`)

    if (!target.workflow || target.workflow.kind !== "lightloop") {
      throw new Error(`Session ${sessionID} does not have an active Light Loop workflow`)
    }

    const stopRequest = target.workflow.stopRequest
    if (!stopRequest) throw new Error(`Session ${sessionID} has no pending stop request`)

    if (stopRequest.reviewSessionID !== ctx.sessionID) {
      throw new Error("Only the recorded reviewer session may approve this stop request")
    }

    // Clear the LightLoop workflow on the target session
    await SessionWorkflowService.setNone(sessionID, { allowRunning: true })

    // Deliver approval notification
    const text = `Light Loop review approved.\n\n${summary}`
    await SessionManager.deliver({
      target: sessionID,
      mail: {
        type: "user",
        summary: { title: "Light Loop review approved" },
        parts: [
          {
            id: Identifier.ascending("part"),
            sessionID,
            messageID: "",
            type: "text",
            text,
            origin: "system",
          },
        ],
        metadata: { source: "light_loop_approved", sourceSessionID: ctx.sessionID },
      },
    })

    return {
      title: "Light Loop approved",
      output: text,
      metadata: { sessionID, loopApproved: true },
    }
  },
})
