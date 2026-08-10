import z from "zod"
import { BossService } from "../session/boss"
import { Tool } from "./tool"
import DESCRIPTION from "./boss-report.txt"

const parameters = z.object({
  summary: z.string().min(1).describe("Summary of what was done, blocked, or needed."),
  status: z.enum(["completed", "blocked", "needs_input"]).optional().describe("Outcome status. Defaults to completed."),
  refs: z.array(z.string()).optional().describe("Optional references (files, IDs, links)."),
})

export const BossReportTool = Tool.define("boss_report", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const result = await BossService.report(ctx.sessionID, params)
    return {
      title: `Report sent (${params.status ?? "completed"})`,
      metadata: { messageID: result.messageID, status: params.status ?? "completed" },
      output: `Report delivered to parent. Summary: ${params.summary}`,
    }
  },
})
