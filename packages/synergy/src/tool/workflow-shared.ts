import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import { WorkflowError, WorkflowRunStore, WorkflowSeats, WorkflowTypes } from "../workflow-run"
import { WorkflowRunExecutor } from "../workflow-run/executor"

/**
 * Shared identity resolution for workflow-run tools. Every tool re-derives the
 * caller's role from `ctx.sessionID` — never trusting a parameter — mirroring
 * the blueprint_loop_finish server-side authorization model.
 */
export namespace WorkflowToolShared {
  export type SeatContext = {
    run: WorkflowTypes.Run
    seat: string
    instance: number
    entity?: WorkflowTypes.Entity
  }

  export async function requireBoss(sessionID: string): Promise<WorkflowTypes.Run> {
    const session = await Session.get(sessionID)
    const binding = session.workflowRun
    if (!binding || binding.role !== "boss") {
      throw new Error("This action is only available to a Boss session that owns a workflow run.")
    }
    return WorkflowRunStore.get(ScopeContext.current.scope.id, binding.runID)
  }

  export async function requireSeat(sessionID: string): Promise<SeatContext> {
    const session = await Session.get(sessionID)
    const binding = session.workflowRun
    if (!binding || binding.role !== "seat" || !binding.seat) {
      throw new Error("This action is only available to a workflow-run seat session.")
    }
    const run = await WorkflowRunStore.get(ScopeContext.current.scope.id, binding.runID)
    const instance = binding.instance ?? 0
    const entity = WorkflowSeats.currentEntity(run, { seat: binding.seat, instance, sessionID })
    return { run, seat: binding.seat, instance, entity }
  }

  export async function updateActiveSeatEntity(input: {
    sessionID: string
    context: SeatContext & { entity: WorkflowTypes.Entity }
    edit: (entity: WorkflowTypes.Entity, run: WorkflowTypes.Run) => void
    afterCommit?: (result: { run: WorkflowTypes.Run; entity: WorkflowTypes.Entity }) => Promise<void>
  }): Promise<{ run: WorkflowTypes.Run; entity: WorkflowTypes.Entity }> {
    const scopeID = ScopeContext.current.scope.id
    const { context } = input
    return WorkflowRunExecutor.run(scopeID, context.run.id, async () => {
      const updated = await WorkflowRunStore.update(
        scopeID,
        context.run.id,
        (draft) => {
          const binding = draft.seats.find(
            (candidate) =>
              candidate.seat === context.seat &&
              candidate.instance === context.instance &&
              candidate.sessionID === input.sessionID,
          )
          if (binding?.entityID !== context.entity.id) {
            throw new WorkflowError.NotAuthorized({ reason: "actor seat no longer owns this entity" })
          }
          const entity = draft.entities.find((candidate) => candidate.id === context.entity.id)
          if (!entity) {
            throw new WorkflowError.TransitionRejected({ reason: `unknown entity ${context.entity.id}` })
          }
          input.edit(entity, draft)
        },
        {
          expectedRunStatus: "active",
          expectedEntityState: { entityID: context.entity.id, state: context.entity.state },
        },
      )
      const entity = updated.entities.find((candidate) => candidate.id === context.entity.id)
      if (!entity) throw new WorkflowError.TransitionRejected({ reason: `unknown entity ${context.entity.id}` })
      const result = { run: updated, entity }
      await input.afterCommit?.(result)
      return result
    })
  }
}
