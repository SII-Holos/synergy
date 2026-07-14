import z from "zod"
import { Tool } from "./tool"
import { WorkflowRunService } from "../workflow-run"
import { WorkflowToolShared } from "./workflow-shared"
import DESCRIPTION from "./workflow-run-control.txt"

const parameters = z.object({
  action: z.enum(["pause", "resume", "cancel"]).describe("Lifecycle action for the run you own."),
})

export const WorkflowRunControlTool = Tool.define("workflow_run_control", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const run = await WorkflowToolShared.requireBoss(ctx.sessionID)
    const updated = await WorkflowRunService.control(run.id, params.action)
    return {
      title: `Run ${params.action}`,
      output: `Workflow run ${updated.id} is now ${updated.status}.`,
      metadata: { runID: updated.id, status: updated.status },
    }
  },
})
