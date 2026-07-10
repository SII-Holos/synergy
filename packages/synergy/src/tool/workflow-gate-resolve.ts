import z from "zod"
import { Tool } from "./tool"
import { WorkflowRunService } from "../workflow-run"
import { WorkflowToolShared } from "./workflow-shared"
import DESCRIPTION from "./workflow-gate-resolve.txt"

const parameters = z.object({
  gateInstanceID: z.string().describe("The pending gate instance id (wfg_...)."),
  resolution: z.string().describe("One of the gate's declared resolutions, e.g. 'merge' | 'rework'."),
})

export const WorkflowGateResolveTool = Tool.define("workflow_gate_resolve", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const run = await WorkflowToolShared.requireBoss(ctx.sessionID)
    const updated = await WorkflowRunService.resolveGate({
      runID: run.id,
      gateInstanceID: params.gateInstanceID,
      resolution: params.resolution,
      resolvedBy: "boss_agent",
    })
    const gate = updated.gates.find((g) => g.id === params.gateInstanceID)
    return {
      title: `Gate resolved: ${params.resolution}`,
      output: `Gate ${params.gateInstanceID} resolved as "${params.resolution}". Entity ${gate?.entityID ?? "-"} advanced.`,
      metadata: { runID: run.id, gateInstanceID: params.gateInstanceID, resolution: params.resolution } as Record<
        string,
        any
      >,
    }
  },
})
