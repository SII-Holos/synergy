import z from "zod"
import { BossService } from "../boss"
import { Tool } from "../../tool/tool"
import DESCRIPTION from "./boss-assign.txt"

const parameters = z.object({
  sessionID: z.string().min(1).describe("Worker session ID (ses_xxx) to assign the task to."),
  taskID: z.string().min(1).describe("Stable task ID chosen by the caller; idempotent per (caller, taskID)."),
  task: z.string().min(1).describe("The task text the worker must complete."),
  context: z.string().optional().describe("Optional context to include with the task."),
  acceptance: z.array(z.string()).optional().describe("Optional acceptance criteria."),
})

export const BossAssignTool = Tool.define("boss_assign", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const result = await BossService.assign(ctx.sessionID, params, {
      anchorMessageID: typeof ctx.extra?.userMessageID === "string" ? ctx.extra.userMessageID : undefined,
    })
    return {
      title: result.created ? `Task assigned to ${params.sessionID}` : `Task already assigned (${params.taskID})`,
      metadata: { sessionID: params.sessionID, taskID: params.taskID, created: result.created },
      output: result.created
        ? `Task "${params.taskID}" delivered to worker ${params.sessionID}.`
        : `Task "${params.taskID}" was already delivered to ${params.sessionID} (idempotent, not re-delivered).`,
    }
  },
})
