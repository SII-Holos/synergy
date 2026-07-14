import z from "zod"
import { Tool } from "./tool"
import { Identifier } from "../id/id"
import { ScopeContext } from "../scope/context"
import { SessionInbox } from "../session/inbox"
import { SessionManager } from "../session/manager"
import { WorkflowRunStore, WorkflowTypes } from "../workflow-run"
import { WorkflowToolShared } from "./workflow-shared"
import DESCRIPTION from "./workflow-block.txt"

const parameters = z.object({
  reason: z.string().describe("Concrete reason you cannot make progress."),
})

export const WorkflowBlockTool = Tool.define("workflow_block", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const scopeID = ScopeContext.current.scope.id
    const seatContext = await WorkflowToolShared.requireSeat(ctx.sessionID)
    if (!seatContext.entity) throw new Error("You have no entity assigned; nothing to block.")

    const { run, entity } = await WorkflowToolShared.updateActiveSeatEntity({
      sessionID: ctx.sessionID,
      context: { ...seatContext, entity: seatContext.entity },
      edit(draftEntity) {
        draftEntity.state = WorkflowTypes.BLOCKED_STATE
        draftEntity.blockedReason = params.reason
        draftEntity.time.updated = Date.now()
        draftEntity.time.stateEntered = Date.now()
      },
      async afterCommit(result) {
        await WorkflowRunStore.appendEvent(
          scopeID,
          { id: result.run.id },
          {
            kind: "entity_blocked",
            entityID: result.entity.id,
            message: params.reason,
          },
        )
        await SessionInbox.deliver({
          sessionID: result.run.bossSessionID,
          mode: "steer",
          message: {
            role: "user",
            origin: { type: "system", detail: "workflow_boss_notice" },
            visible: true,
            parts: [
              {
                id: Identifier.ascending("part"),
                type: "text",
                text: `[workflow ${result.run.title}] Entity "${result.entity.title}" (${result.entity.id}) is blocked: ${params.reason}`,
                origin: "system",
              },
            ],
            summary: { title: `Blocked: ${result.entity.title}` },
            metadata: { workflowRun: { runID: result.run.id, entityID: result.entity.id } },
          },
        })
        if (!SessionManager.isRunning(result.run.bossSessionID)) {
          SessionManager.scheduleWake(result.run.bossSessionID, "workflow_boss_notice")
        }
      },
    })

    return {
      title: "Entity blocked",
      output: `Entity ${entity.id} is now blocked. The Boss has been notified.`,
      metadata: { runID: run.id, entityID: entity.id },
    }
  },
})
