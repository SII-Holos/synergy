import type { Info as SessionInfo } from "../session/types"
import { CharterStore } from "./charter-store"
import { WorkflowRunService } from "./service"
import { WorkflowRunStore } from "./store"
import { WorkflowTypes } from "./types"

export namespace WorkflowRunLifecycle {
  export async function beforeSessionDelete(session: SessionInfo): Promise<void> {
    const binding = session.workflowRun
    if (!binding) return
    const scopeID = session.scope.id
    const run = await WorkflowRunStore.getOrUndefined(scopeID, binding.runID)
    if (!run) return

    if (binding.role === "boss") {
      if (run.status === "active" || run.status === "paused") {
        await WorkflowRunService.control(run.id, "cancel")
      }
      return
    }

    if (binding.role !== "seat" || (run.status !== "active" && run.status !== "paused")) return
    const charter = await CharterStore.get(scopeID, run.charterRef.id, run.charterRef.version)
    let blockedEntityID: string | undefined
    await WorkflowRunStore.update(
      scopeID,
      run.id,
      (draft) => {
        const seat = draft.seats.find((candidate) => candidate.sessionID === session.id)
        if (!seat) return
        const entity = seat.entityID ? draft.entities.find((candidate) => candidate.id === seat.entityID) : undefined
        if (entity) {
          const now = Date.now()
          if (!WorkflowTypes.isTerminalState(charter, entity.state)) {
            blockedEntityID = entity.id
            entity.state = WorkflowTypes.BLOCKED_STATE
            entity.blockedReason = "assigned seat session was deleted"
            entity.time.stateEntered = now
          }
          entity.assignedSeat = undefined
          delete entity.bindings.seatSessionID
          entity.pendingHandoffID = undefined
          entity.time.updated = now
        }
        seat.sessionID = undefined
        seat.entityID = undefined
        seat.status = "unbound"
      },
      { expectedRunStatus: ["active", "paused"] },
    )
    if (blockedEntityID) {
      await WorkflowRunStore.appendEvent(scopeID, run, {
        kind: "entity_blocked",
        entityID: blockedEntityID,
        message: "assigned seat session was deleted",
      })
    }
  }
}
