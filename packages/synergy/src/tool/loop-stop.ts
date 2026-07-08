import z from "zod"
import { Tool } from "./tool"
import { Session } from "../session"
import { SessionWorkflowService } from "../session/workflow"
import { Identifier } from "../id/id"
import DESCRIPTION from "./loop-stop.txt"

const parameters = z.object({
  summary: z.string().optional().describe("Optional summary of what was completed."),
})

export const LoopStopTool = Tool.define("loop_stop", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const session = await Session.get(ctx.sessionID)
    if (session.workflow?.kind !== "lightloop") {
      throw new Error("No active Light Loop workflow on this session")
    }

    await SessionWorkflowService.setNone(ctx.sessionID, { allowRunning: true })

    const text = `Light loop stopped.${params.summary ? ` Summary: ${params.summary}` : ""}`

    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: ctx.messageID,
      sessionID: ctx.sessionID,
      type: "text",
      text,
      synthetic: true,
      time: { start: Date.now(), end: Date.now() },
    })

    return {
      title: "Light loop stopped",
      output: text,
      metadata: { loopStopped: true },
    }
  },
})
