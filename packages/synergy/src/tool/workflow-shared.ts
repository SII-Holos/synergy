import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import { WorkflowRunStore, WorkflowTypes } from "../workflow-run"

/**
 * Shared identity resolution for workflow-run tools. Every tool re-derives the
 * caller's role from `ctx.sessionID` — never trusting a parameter — mirroring
 * the blueprint_loop_finish server-side authorization model.
 */
export namespace WorkflowToolShared {
  export async function requireBoss(sessionID: string): Promise<WorkflowTypes.Run> {
    const session = await Session.get(sessionID)
    const binding = session.workflowRun
    if (!binding || binding.role !== "boss") {
      throw new Error("This action is only available to a Boss session that owns a workflow run.")
    }
    return WorkflowRunStore.get(ScopeContext.current.scope.id, binding.runID)
  }

  export async function requireSeat(
    sessionID: string,
  ): Promise<{ run: WorkflowTypes.Run; seat: string; instance: number; entity?: WorkflowTypes.Entity }> {
    const session = await Session.get(sessionID)
    const binding = session.workflowRun
    if (!binding || binding.role !== "seat" || !binding.seat) {
      throw new Error("This action is only available to a workflow-run seat session.")
    }
    const run = await WorkflowRunStore.get(ScopeContext.current.scope.id, binding.runID)
    const entity = run.entities.find(
      (e) => e.assignedSeat?.seat === binding.seat && e.bindings.seatSessionID === sessionID,
    )
    return { run, seat: binding.seat, instance: binding.instance ?? 0, entity }
  }
}
