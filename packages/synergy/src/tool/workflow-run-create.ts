import z from "zod"
import { Tool } from "./tool"
import { ScopeContext } from "../scope/context"
import { Agent } from "../agent/agent"
import { Session } from "../session"
import { WorkflowRunService, IssueToPrCharter } from "../workflow-run"
import DESCRIPTION from "./workflow-run-create.txt"

const parameters = z.object({
  title: z.string().describe("Human-readable title for this run."),
  charterID: z
    .string()
    .optional()
    .describe("Charter id to instantiate. Omit to use the built-in Issue → PR → Test charter."),
  version: z.number().int().min(1).optional().describe("Charter version. Omit for the latest."),
  maxModelCalls: z.number().int().min(0).optional().describe("Model-call budget for the whole run (0 = unlimited)."),
})

export const WorkflowRunCreateTool = Tool.define("workflow_run_create", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const scopeID = ScopeContext.current.scope.id
    let charterID = params.charterID
    if (!charterID || charterID === IssueToPrCharter.CHARTER_ID) {
      const seeded = await IssueToPrCharter.ensureSeeded(scopeID)
      charterID = seeded.id
    }

    const agent = await Agent.get(ctx.agent)
    const bossControlProfile = await Session.resolveEffectiveControlProfile({
      sessionID: ctx.sessionID,
      agentControlProfile: agent.controlProfile,
    })
    const run = await WorkflowRunService.create({
      charterID,
      version: params.version,
      title: params.title,
      bossSessionID: ctx.sessionID,
      maxModelCalls: params.maxModelCalls,
      bossControlProfile,
    })

    return {
      title: `Workflow run created: ${run.title}`,
      output: [
        `Run ${run.id} is active. This session is now the Boss.`,
        `Charter: ${run.charterRef.id} v${run.charterRef.version}`,
        `Seats: ${run.seats.map((s) => `${s.seat}#${s.instance}`).join(", ")}`,
        "Enqueue work with workflow_entity_add.",
      ].join("\n"),
      metadata: { runID: run.id, charterRef: run.charterRef },
    }
  },
})
