import { Bus } from "../bus"
import { LoopEvent } from "../blueprint/event"
import { CortexEvent } from "../cortex/event"
import { CortexTypes } from "../cortex/types"
import { MessageV2 } from "../session/message-v2"
import { ScopedState } from "../scope/scoped-state"
import { Log } from "../util/log"
import { WorkflowEvent } from "./event"
import { WorkflowMachine } from "./machine"
import { WorkflowRunStore } from "./store"
import { WorkflowTypes } from "./types"

/**
 * WorkflowBridge translates platform facts into entity state transitions:
 *  - a lattice-independent BlueprintLoop (source "workflow") reaching a terminal
 *    state re-evaluates the entity whose `loopID` binding matches;
 *  - a handoff user message materialising in a seat session is a deterministic
 *    acknowledgement (`handoff_acked`) — the ack a guard can depend on;
 *  - a hidden contractor Cortex task completing records a submission and
 *    re-evaluates the entity.
 *
 * Like LatticeBridge, it only acts on active runs; a paused/terminal run is
 * inert.
 */
export namespace WorkflowBridge {
  const log = Log.create({ service: "workflow.bridge" })

  const subscription = ScopedState.create(
    () => {
      const unsubLoop = Bus.subscribe(LoopEvent.Updated, (event) =>
        handleLoop(event.properties.loop).catch((error) =>
          log.error("workflow bridge loop handler failed", { loopID: event.properties.loop.id, error }),
        ),
      )
      const unsubMessage = Bus.subscribe(MessageV2.Event.Updated, (event) =>
        handleMessage(event.properties.info).catch((error) =>
          log.error("workflow bridge message handler failed", { error }),
        ),
      )
      const unsubCortex = Bus.subscribe(CortexEvent.TaskCompleted, (event) =>
        handleContractor(event.properties.task).catch((error) =>
          log.error("workflow bridge contractor handler failed", { error }),
        ),
      )
      const unsubWorkflow = Bus.subscribe(WorkflowEvent.EventAppended, (event) => {
        if (event.properties.event.kind !== "run_resumed") return
        const { scopeID, runID } = event.properties.event
        return wakeRunnableSeats(scopeID, runID).catch((error) =>
          log.error("workflow bridge resume wake failed", { scopeID, runID, error }),
        )
      })
      return { unsubscribe: () => [unsubLoop, unsubMessage, unsubCortex, unsubWorkflow].forEach((u) => u()) }
    },
    async (state) => state.unsubscribe(),
  )

  export function init(): () => void {
    return subscription().unsubscribe
  }

  async function findRunByEntityBinding(
    scopeID: string,
    predicate: (entity: WorkflowTypes.Entity) => boolean,
  ): Promise<{ run: WorkflowTypes.Run; entity: WorkflowTypes.Entity } | undefined> {
    const runs = await WorkflowRunStore.list(scopeID)
    for (const run of runs) {
      if (run.status !== "active") continue
      const entity = run.entities.find(predicate)
      if (entity) return { run, entity }
    }
    return undefined
  }

  async function handleLoop(loop: {
    id: string
    scopeID: string
    status: string
    source: "user" | "lattice" | "workflow"
  }): Promise<void> {
    if (loop.source !== "workflow") return
    if (loop.status !== "completed" && loop.status !== "failed" && loop.status !== "cancelled") return
    const match = await findRunByEntityBinding(loop.scopeID, (e) => e.bindings.loopID === loop.id)
    if (!match) return
    await WorkflowMachine.evaluateEventTransitions(loop.scopeID, match.run.id, match.entity.id)
  }

  async function handleMessage(info: MessageV2.Info): Promise<void> {
    if (info.role !== "user") return
    const scopeID = await scopeForSession(info.sessionID)
    if (!scopeID) return
    await projectHandoffMessage(scopeID, info, { evaluate: true })
  }

  async function projectHandoffMessage(
    scopeID: string,
    info: MessageV2.Info,
    options?: { evaluate?: boolean },
  ): Promise<boolean> {
    if (info.role !== "user") return false
    const workflow = workflowMetadata(info.metadata)
    const handoffID = workflow?.handoffID
    const runID = workflow?.runID
    const entityID = workflow?.entityID
    if (!handoffID || !runID || !entityID) return false

    const run = await WorkflowRunStore.getOrUndefined(scopeID, runID)
    if (!run || run.status !== "active") return false
    const binding = run.seats.find((seat) => seat.sessionID === info.sessionID && seat.entityID === entityID)
    const entity = run.entities.find((candidate) => candidate.id === entityID)
    if (!binding || entity?.pendingHandoffID !== handoffID) return false
    if (
      entity.bindings.seatSessionID !== info.sessionID ||
      entity.assignedSeat?.seat !== binding.seat ||
      entity.assignedSeat.instance !== binding.instance
    ) {
      return false
    }

    await WorkflowRunStore.appendEvent(
      scopeID,
      { id: runID },
      {
        id: handoffAckEventID(handoffID),
        kind: "handoff_acked",
        entityID,
        data: { handoffID, sessionID: info.sessionID, messageID: info.id },
      },
    )
    if (options?.evaluate !== false) {
      await WorkflowMachine.evaluateEventTransitions(scopeID, runID, entityID)
    }
    return true
  }

  export async function projectPersistedHandoffAck(
    input: { scopeID: string; runID: string; entityID: string; handoffID: string },
    options?: { evaluate?: boolean },
  ): Promise<boolean> {
    const run = await WorkflowRunStore.getOrUndefined(input.scopeID, input.runID)
    if (!run || run.status !== "active") return false
    const entity = run.entities.find((candidate) => candidate.id === input.entityID)
    if (entity?.pendingHandoffID !== input.handoffID) return false
    const binding = run.seats.find(
      (candidate) => candidate.entityID === input.entityID && candidate.sessionID !== undefined,
    )
    if (!binding?.sessionID) return false
    if (
      entity.bindings.seatSessionID !== binding.sessionID ||
      entity.assignedSeat?.seat !== binding.seat ||
      entity.assignedSeat.instance !== binding.instance
    ) {
      return false
    }

    const { Session } = await import("../session")
    const message = (await Session.messages({ sessionID: binding.sessionID, raw: true })).find((candidate) => {
      if (candidate.info.role !== "user") return false
      const metadata = workflowMetadata(candidate.info.metadata)
      return (
        metadata?.runID === input.runID &&
        metadata.entityID === input.entityID &&
        metadata.handoffID === input.handoffID
      )
    })
    if (!message) return false
    return projectHandoffMessage(input.scopeID, message.info, options)
  }

  export async function projectPersistedHandoffAcks(scopeID: string, runID: string): Promise<number> {
    const run = await WorkflowRunStore.getOrUndefined(scopeID, runID)
    if (!run || run.status !== "active") return 0
    let projected = 0
    for (const entity of run.entities) {
      if (!entity.pendingHandoffID) continue
      if (
        await projectPersistedHandoffAck(
          { scopeID, runID, entityID: entity.id, handoffID: entity.pendingHandoffID },
          { evaluate: false },
        )
      ) {
        projected++
      }
    }
    return projected
  }

  async function wakeRunnableSeats(scopeID: string, runID: string): Promise<void> {
    const run = await WorkflowRunStore.getOrUndefined(scopeID, runID)
    if (!run || run.status !== "active") return
    const { SessionInbox } = await import("../session/inbox")
    const { SessionManager } = await import("../session/manager")
    for (const binding of run.seats) {
      if (!binding.sessionID || !binding.entityID) continue
      const entity = run.entities.find((candidate) => candidate.id === binding.entityID)
      if (entity?.assignedSeat?.seat !== binding.seat || entity.assignedSeat.instance !== binding.instance) continue
      if (SessionManager.isRunning(binding.sessionID)) continue
      if (!(await SessionInbox.hasRunnableItem(binding.sessionID))) continue
      SessionManager.scheduleWake(binding.sessionID, "workflow_resumed")
    }
  }

  function handoffAckEventID(handoffID: string): string {
    return `wfv_handoff_ack_${handoffID.slice("wfh_".length)}`
  }

  async function handleContractor(task: CortexTypes.Task): Promise<void> {
    const owner = task.owner
    if (owner?.kind !== "workflow_run" || !owner.runID) return
    if (!task.parentSessionID) return
    const scopeID = await scopeForSession(task.parentSessionID)
    if (!scopeID) return
    const run = await WorkflowRunStore.getOrUndefined(scopeID, owner.runID)
    if (!run || run.status !== "active") return
    const entityID = owner.entityID
    if (!entityID) throw new Error(`workflow contractor ${task.id} has no entity owner`)
    if (!run.entities.some((entity) => entity.id === entityID)) {
      throw new Error(`workflow contractor ${task.id} owns unknown entity ${entityID}`)
    }

    if (task.status === "completed") {
      const submission: WorkflowTypes.Submission = {
        id: task.id,
        kind: "deliverable",
        seat: owner.seat ?? "contractor",
        sessionID: task.sessionID,
        summary: contractorSummary(task),
        refs: [task.sessionID],
        time: task.completedAt ?? task.startedAt,
      }
      await WorkflowRunStore.update(
        scopeID,
        run.id,
        (draft) => {
          const entity = draft.entities.find((candidate) => candidate.id === entityID)
          if (!entity) throw new Error(`workflow contractor ${task.id} owns unknown entity ${entityID}`)
          const existing = entity.submissions.find((candidate) => candidate.id === task.id)
          if (existing) {
            if (JSON.stringify(existing) !== JSON.stringify(submission)) {
              throw new Error(`workflow contractor ${task.id} conflicts with an existing submission`)
            }
            return
          }
          entity.submissions.push(submission)
          entity.time.updated = Date.now()
        },
        { expectedRunStatus: "active" },
      )
      await WorkflowRunStore.appendEvent(
        scopeID,
        { id: run.id },
        {
          id: `wfv_${task.id}_submission`,
          kind: "submission_recorded",
          entityID,
          seat: submission.seat,
          data: {
            kind: submission.kind,
            taskID: task.id,
            correlationID: owner.correlationID,
          },
        },
      )
    }

    await WorkflowRunStore.appendEvent(
      scopeID,
      { id: run.id },
      {
        id: `wfv_${task.id}_finished`,
        kind: "contractor_finished",
        entityID,
        data: {
          taskID: task.id,
          status: task.status,
          sessionID: task.sessionID,
          error: task.error,
          correlationID: owner.correlationID,
          outputMode: task.output?.mode,
          seat: owner.seat,
          instance: owner.instance,
        },
      },
    )
    await WorkflowMachine.evaluateEventTransitions(scopeID, run.id, entityID)
  }

  function contractorSummary(task: CortexTypes.Task): string {
    if (task.output?.mode === "summary" || task.output?.mode === "final_response") {
      const value = task.output.value.trim()
      if (value) return value
    }
    if (task.output?.mode === "structured") {
      const value = JSON.stringify(task.output.value)
      if (value) return value
    }
    return `Contractor ${task.id} completed without a textual result.`
  }

  async function scopeForSession(sessionID: string): Promise<string | undefined> {
    const { SessionManager } = await import("../session/manager")
    const session = await SessionManager.getSession(sessionID).catch(() => undefined)
    if (!session) return undefined
    return (session.scope as { id: string }).id
  }

  function workflowMetadata(metadata: unknown): { runID?: string; entityID?: string; handoffID?: string } | undefined {
    if (!metadata || typeof metadata !== "object") return undefined
    const workflow = (metadata as Record<string, unknown>).workflowRun
    if (!workflow || typeof workflow !== "object") return undefined
    const record = workflow as Record<string, unknown>
    return {
      runID: typeof record.runID === "string" ? record.runID : undefined,
      entityID: typeof record.entityID === "string" ? record.entityID : undefined,
      handoffID: typeof record.handoffID === "string" ? record.handoffID : undefined,
    }
  }
}
