import z from "zod"
import { Tool } from "./tool"
import { ScopeContext } from "../scope/context"
import { WorkflowMachine } from "../workflow-run"
import { WorkflowToolShared } from "./workflow-shared"
import DESCRIPTION from "./workflow-entity-unblock.txt"

const parameters = z.object({
  entityID: z.string().describe("ID of the blocked entity to unblock."),
})

export const WorkflowEntityUnblockTool = Tool.define("workflow_entity_unblock", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const scopeID = ScopeContext.current.scope.id

    // Authorize: only the Boss can unblock.
    const run = await WorkflowToolShared.requireBoss(ctx.sessionID)
    const entity = run.entities.find((e) => e.id === params.entityID)
    if (!entity) throw new Error(`Unknown entity ${params.entityID}`)
    if (entity.state !== "blocked") {
      throw new Error(`Entity ${params.entityID} is not blocked (state: ${entity.state})`)
    }
    const previous = entity.blockedReason ?? "(unknown)"

    const result = await WorkflowMachine.submitIntent({
      scopeID,
      runID: run.id,
      entityID: params.entityID,
      transitionID: "unblock",
      actorSessionID: ctx.sessionID,
      fromBoss: true,
    })
    if (!result.ok) throw new Error(`Unblock rejected: ${result.reason}`)

    return {
      title: `Entity unblocked → ${result.entityState}`,
      output: [
        `Entity ${params.entityID} was blocked (${previous}).`,
        `It has returned to "${result.entityState}" and will re-enter the normal pipeline.`,
      ].join("\n"),
      metadata: { runID: run.id, entityID: params.entityID, state: result.entityState },
    }
  },
})
