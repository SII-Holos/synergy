import z from "zod"
import { Tool } from "./tool"
import { WorkflowRunService } from "../workflow-run"
import { WorkflowToolShared } from "./workflow-shared"
import DESCRIPTION from "./workflow-entity-add.txt"

const parameters = z.object({
  title: z.string().describe("Short title of the work unit, e.g. the issue title."),
  description: z.string().optional().describe("What this entity requires."),
  affinityKey: z
    .string()
    .optional()
    .describe("Entities sharing this key prefer the same seat instance (e.g. a module name)."),
  bindings: z
    .record(z.string(), z.string())
    .optional()
    .describe("Initial bindings, e.g. { issueRef, blueprintNoteID }."),
})

export const WorkflowEntityAddTool = Tool.define("workflow_entity_add", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const run = await WorkflowToolShared.requireBoss(ctx.sessionID)
    const entity = await WorkflowRunService.addEntity({
      runID: run.id,
      title: params.title,
      description: params.description,
      affinityKey: params.affinityKey,
      bindings: params.bindings,
    })
    return {
      title: `Entity added: ${entity.title}`,
      output: `Entity ${entity.id} entered state "${entity.state}".`,
      metadata: { runID: run.id, entityID: entity.id, state: entity.state },
    }
  },
})
