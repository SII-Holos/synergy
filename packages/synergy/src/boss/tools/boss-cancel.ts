import z from "zod"
import { BossService } from "../boss"
import { Tool } from "../../tool/tool"
import DESCRIPTION from "./boss-cancel.txt"

const parameters = z.object({
  sessionID: z.string().min(1).describe("Worker session ID (ses_xxx) to cancel work on."),
  taskID: z.string().optional().describe("Specific task ID to cancel. Omit to cancel all tasks from this caller."),
})

export const BossCancelTool = Tool.define("boss_cancel", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const result = await BossService.cancel(ctx.sessionID, params)
    return {
      title: result.cancelled
        ? `Cancelled work on ${params.sessionID}`
        : `No matching work to cancel on ${params.sessionID}`,
      metadata: { sessionID: params.sessionID, taskID: params.taskID, cancelled: result.cancelled },
      output: result.cancelled
        ? `Cancelled work on worker ${params.sessionID}${params.taskID ? ` for task ${params.taskID}` : ""}.`
        : `No matching pending work found on ${params.sessionID}.`,
    }
  },
})
