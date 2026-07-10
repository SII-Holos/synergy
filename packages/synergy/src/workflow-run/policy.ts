import { Identifier } from "../id/id"
import { Log } from "../util/log"
import type { ContinuationKernel } from "../session/continuation-kernel"
import { SessionManager } from "../session/manager"
import { WorkflowModelCalls } from "./model-calls"
import { WorkflowRunStore } from "./store"
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

    const run = await WorkflowRunStore.getOrUndefined(gate.scopeID, binding.runID).catch(() => undefined)
    if (!run || run.status !== "active") return false

    // Flush budget accounting; pause + notify boss when exhausted.
    const used = (await WorkflowModelCalls.flush(gate.scopeID, binding.runID)) ?? run.budget.used
    if (run.budget.maxModelCalls > 0 && used >= run.budget.maxModelCalls) {
      await WorkflowRunStore.update(gate.scopeID, binding.runID, (draft) => {
        draft.status = "paused"
        draft.statusReason = "model_call_budget_exhausted"
      })
      await WorkflowRunStore.appendEvent(gate.scopeID, { id: binding.runID }, { kind: "budget_exhausted" })
      return true
    }

    const seatSessionID = gate.sessionID
    const entity = run.entities.find(
      (e) =>
        e.bindings.seatSessionID === seatSessionID &&
        e.assignedSeat?.seat === binding.seat &&
        // The seat binding must still own this entity — release_seat
        // clears binding.entityID but entity.bindings.seatSessionID
        // may still be stale. Only deliver a continuation when the
        // binding and entity agree.
        run.seats.some((s) => s.seat === binding.seat && s.instance === binding.instance && s.entityID === e.id),
    )
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
  await SessionManager.deliver({
    target: sessionID,
    mail: {
      type: "user",
      summary: { title: `Continue ${entity.title}` },
      parts: [
        {
          id: Identifier.ascending("part"),
          sessionID,
          messageID: "",
          type: "text",
          text,
          synthetic: true,
        },
      ],
      metadata: { source: "workflow_continuation", workflowRun: { runID: run.id, entityID: entity.id } },
    },
  }).catch((error) => log.error("workflow continuation delivery failed", { sessionID, error }))
}
