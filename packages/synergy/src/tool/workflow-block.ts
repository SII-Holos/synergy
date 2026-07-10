import z from "zod"
import { Tool } from "./tool"
import { Identifier } from "../id/id"
import { ScopeContext } from "../scope/context"
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
    const { run, entity } = await WorkflowToolShared.requireSeat(ctx.sessionID)
    if (!entity) throw new Error("You have no entity assigned; nothing to block.")

    await WorkflowRunStore.update(scopeID, run.id, (draft) => {
      const e = draft.entities.find((x) => x.id === entity.id)
      if (e && e.state !== WorkflowTypes.BLOCKED_STATE) {
        e.state = WorkflowTypes.BLOCKED_STATE
        e.blockedReason = params.reason
        e.time.updated = Date.now()
        e.time.stateEntered = Date.now()
      }
    })
    await WorkflowRunStore.appendEvent(
      scopeID,
      { id: run.id },
      {
        kind: "entity_blocked",
        entityID: entity.id,
        message: params.reason,
      },
    )

    // Notify the boss.
    const part = {
      id: Identifier.ascending("part"),
      sessionID: run.bossSessionID,
      messageID: Identifier.ascending("message"),
      type: "text" as const,
      text: `[workflow ${run.title}] Entity "${entity.title}" (${entity.id}) is blocked: ${params.reason}`,
      synthetic: true,
    }
    await SessionManager.deliver({
      target: run.bossSessionID,
      mail: {
        type: "user",
        noReply: true,
        parts: [part],
        summary: { title: `Blocked: ${entity.title}` },
        metadata: { source: "workflow_boss_notice", workflowRun: { runID: run.id } },
      },
      waitForProcessing: false,
    }).catch(() => undefined)

    return {
      title: "Entity blocked",
      output: `Entity ${entity.id} is now blocked. The Boss has been notified.`,
      metadata: { runID: run.id, entityID: entity.id } as Record<string, any>,
    }
  },
})
