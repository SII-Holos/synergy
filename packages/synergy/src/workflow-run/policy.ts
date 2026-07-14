import { Identifier } from "../id/id"
import { Log } from "../util/log"
import type { ContinuationKernel } from "../session/continuation-kernel"
import { SessionInbox } from "../session/inbox"
import { SessionManager } from "../session/manager"
import { WorkflowRunStore } from "./store"
import { WorkflowSeats } from "./seats"
import { WorkflowTypes } from "./types"

const log = Log.create({ service: "workflow.policy" })

/**
 * WorkflowContinuationPolicy keeps a workflow-run seat progressing when its
 * session goes idle. Registered below BlueprintLoop (100) and Lattice (50): a
 * live BlueprintLoop inside a seat owns the idle while it runs; once it
 * finishes, the bridge advances the entity and this policy carries the next
 * step. Boss and contractor sessions are not driven here.
 */
export const WorkflowContinuationPolicy: ContinuationKernel.Policy = {
  id: "workflow_run",
  priority: 40,
  async handle(gate) {
    const binding = gate.session.workflowRun
    if (!binding || binding.role !== "seat") return false

    const run = await WorkflowRunStore.getOrUndefined(gate.scopeID, binding.runID)
    if (!run || run.status !== "active") return false

    if (run.budget.maxModelCalls > 0 && run.budget.used >= run.budget.maxModelCalls) {
      await WorkflowRunStore.update(
        gate.scopeID,
        binding.runID,
        (draft) => {
          draft.status = "paused"
          draft.statusReason = "model_call_budget_exhausted"
        },
        { expectedRunStatus: "active" },
      )
      await WorkflowRunStore.appendEvent(gate.scopeID, { id: binding.runID }, { kind: "budget_exhausted" })
      return true
    }

    const seat = binding.seat
    const instance = binding.instance ?? 0
    if (!seat) return false
    const seatBinding = WorkflowSeats.find(run, seat, instance)
    const boundEntity = WorkflowSeats.currentEntity(run, { seat, instance, sessionID: gate.sessionID })
    if (
      seatBinding?.entityID &&
      (!boundEntity || boundEntity.assignedSeat?.seat !== seat || boundEntity.assignedSeat.instance !== instance)
    ) {
      let released = false
      await WorkflowRunStore.update(
        gate.scopeID,
        binding.runID,
        (draft) => {
          const current = WorkflowSeats.find(draft, seat, instance)
          const entity = current?.entityID ? draft.entities.find((item) => item.id === current.entityID) : undefined
          if (
            current?.sessionID !== gate.sessionID ||
            !current.entityID ||
            (entity?.assignedSeat?.seat === seat && entity.assignedSeat.instance === instance)
          ) {
            return
          }
          current.entityID = undefined
          current.status = "idle"
          released = true
        },
        { expectedRunStatus: "active" },
      )
      if (!released) return false
      const { WorkflowMachine } = await import("./machine")
      await WorkflowMachine.redrivePending(gate.scopeID, binding.runID)
      const refreshed = await WorkflowRunStore.getOrUndefined(gate.scopeID, binding.runID)
      const target = boundEntity?.assignedSeat
      const targetSessionID = target
        ? WorkflowSeats.find(refreshed ?? run, target.seat, target.instance)?.sessionID
        : undefined
      if (targetSessionID && !SessionManager.isRunning(targetSessionID)) {
        SessionManager.scheduleWake(targetSessionID, "workflow_handoff_after_release")
      }
      return true
    }

    const seatSessionID = gate.sessionID
    const entity = boundEntity
    if (!entity) return false
    if (entity.state === WorkflowTypes.BLOCKED_STATE) return false

    // The seat replied but did not submit or advance — nudge it to continue or
    // submit. (BlueprintLoop-driven seats never reach here while their loop is
    // live because that policy has higher priority.)
    await deliverContinuation(seatSessionID, run, entity)
    return true
  },
}

async function deliverContinuation(
  sessionID: string,
  run: WorkflowTypes.Run,
  entity: WorkflowTypes.Entity,
): Promise<void> {
  const text = [
    `<workflow-continuation>`,
    `Entity "${entity.title}" (${entity.id}) is in state "${entity.state}" and still assigned to you.`,
    `A normal reply does not advance the workflow. If the work is not complete, continue now.`,
    `If it is complete, record the outcome with workflow_submit. If blocked, call workflow_block.`,
    `</workflow-continuation>`,
  ].join("\n")
  await SessionInbox.deliver({
    sessionID,
    mode: "steer",
    message: {
      role: "user",
      origin: { type: "system", detail: "workflow_continuation" },
      visible: false,
      parts: [
        {
          id: Identifier.ascending("part"),
          type: "text",
          text,
          origin: "system",
        },
      ],
      summary: { title: `Continue ${entity.title}` },
      metadata: { workflowRun: { runID: run.id, entityID: entity.id } },
    },
  })
  if (!SessionManager.isRunning(sessionID)) {
    SessionManager.scheduleWake(sessionID, "workflow_continuation")
  }
}
