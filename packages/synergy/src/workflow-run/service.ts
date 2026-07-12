import { Identifier } from "../id/id"
import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import { Agent } from "../agent/agent"
import { CharterStore } from "./charter-store"
import { IssueToPrCharter } from "./builtin/issue-to-pr"
import { WorkflowError } from "./error"
import { WorkflowMachine } from "./machine"
import { WorkflowModelCalls } from "./model-calls"
import { WorkflowRunStore } from "./store"
import { WorkflowSeats } from "./seats"
import { WorkflowTypes } from "./types"

/**
 * WorkflowRunService — run lifecycle orchestration. Session workflow projection
 * (session.workflowRun) is written here for the boss; seat sessions get theirs
 * in WorkflowSeats.ensureSession. Only run state and its bindings are mutated.
 */
export namespace WorkflowRunService {
  export type CreateInput = {
    charterID: string
    version?: number
    title: string
    bossSessionID: string
    maxModelCalls?: number
  }

  export async function create(input: CreateInput): Promise<WorkflowTypes.Run> {
    const scopeID = ScopeContext.current.scope.id
    // Auto-seed the built-in charter so it can be instantiated straight from the
    // UI/route without a separate seeding step.
    if (
      input.charterID === IssueToPrCharter.CHARTER_ID &&
      !(await CharterStore.getOrUndefined(scopeID, input.charterID))
    ) {
      await IssueToPrCharter.ensureSeeded(scopeID)
    }
    const charter = await CharterStore.get(scopeID, input.charterID, input.version)

    // Validate every seat's agent resolves.
    for (const seat of charter.seats) {
      const agent = await Agent.get(seat.agent).catch(() => undefined)
      if (!agent)
        throw new WorkflowError.CharterInvalid({
          errors: [`seat '${seat.name}' references unknown agent '${seat.agent}'`],
        })
    }

    const boss = await Session.get(input.bossSessionID)
    if (boss.scope.id !== scopeID) {
      throw new Error(`Boss session ${input.bossSessionID} is not in the current scope.`)
    }
    if (boss.workflowRun) {
      throw new Error(`Session ${input.bossSessionID} is already bound to workflow run ${boss.workflowRun.runID}.`)
    }

    const run = await WorkflowRunStore.create({
      scopeID,
      charterRef: { id: charter.id, version: charter.version },
      title: input.title,
      bossSessionID: input.bossSessionID,
      seats: WorkflowSeats.initialBindings(charter),
      maxModelCalls: input.maxModelCalls ?? charter.budget.maxModelCalls,
    })

    await Session.update(input.bossSessionID, (draft) => {
      draft.workflowRun = { runID: run.id, role: "boss" }
    })
    return run
  }

  export async function addEntity(input: {
    runID: string
    title: string
    description?: string
    affinityKey?: string
    bindings?: Record<string, string>
  }): Promise<WorkflowTypes.Entity> {
    const scopeID = ScopeContext.current.scope.id
    const run = await WorkflowRunStore.get(scopeID, input.runID)
    if (run.status !== "active") throw new Error(`run is ${run.status}, not active`)
    const charter = await CharterStore.get(scopeID, run.charterRef.id, run.charterRef.version)

    const now = Date.now()
    const entity: WorkflowTypes.Entity = {
      id: Identifier.ascending("workflow_entity"),
      runID: run.id,
      title: input.title,
      description: input.description,
      state: charter.entityInitialState,
      bindings: input.bindings ?? {},
      submissions: [],
      affinityKey: input.affinityKey,
      time: { created: now, updated: now, stateEntered: now },
    }
    await WorkflowRunStore.update(scopeID, input.runID, (draft) => {
      draft.entities.push(entity)
    })
    await WorkflowRunStore.appendEvent(
      scopeID,
      { id: input.runID },
      {
        kind: "entity_added",
        entityID: entity.id,
        message: entity.title,
      },
    )
    // Kick the state machine — the first transition out of the initial state is
    // typically an event transition (assign_entity).
    await WorkflowMachine.evaluateEventTransitions(scopeID, input.runID, entity.id)
    return (await WorkflowRunStore.get(scopeID, input.runID)).entities.find((e) => e.id === entity.id) ?? entity
  }

  export async function control(runID: string, action: "pause" | "resume" | "cancel"): Promise<WorkflowTypes.Run> {
    const scopeID = ScopeContext.current.scope.id
    const run = await WorkflowRunStore.getOrUndefined(scopeID, runID)
    if (!run) throw new WorkflowError.RunNotFound({ runID })

    if (action === "pause") {
      const updated = await WorkflowRunStore.update(scopeID, runID, (draft) => {
        if (draft.status === "active") {
          draft.status = "paused"
          draft.statusReason = "user_paused"
        }
      })
      await WorkflowRunStore.appendEvent(scopeID, { id: runID }, { kind: "run_paused", message: "user_paused" })
      return updated
    }
    if (action === "resume") {
      const updated = await WorkflowRunStore.update(scopeID, runID, (draft) => {
        if (draft.status === "paused") {
          draft.status = "active"
          draft.statusReason = undefined
        }
      })
      await WorkflowRunStore.appendEvent(scopeID, { id: runID }, { kind: "run_resumed" })
      // Re-drive any entities that can advance now.
      for (const entity of updated.entities) {
        await WorkflowMachine.evaluateEventTransitions(scopeID, runID, entity.id).catch(() => undefined)
      }
      return updated
    }
    // cancel: stop real execution first, then mark the domain run cancelled.
    await stopRunExecution(scopeID, run)
    WorkflowModelCalls.clear(runID)
    const updated = await WorkflowRunStore.update(scopeID, runID, (draft) => {
      draft.status = "cancelled"
      draft.time.completed = Date.now()
      for (const seat of draft.seats) {
        if (seat.status === "working" || seat.status === "waiting") seat.status = "idle"
        seat.activeTaskID = undefined
      }
    })
    await WorkflowRunStore.appendEvent(scopeID, { id: runID }, { kind: "run_cancelled" })
    return updated
  }

  async function stopRunExecution(scopeID: string, run: WorkflowTypes.Run): Promise<void> {
    const { Cortex } = await import("../cortex")
    const { SessionInvoke } = await import("../session/invoke")
    const { BlueprintLoopStore } = await import("../blueprint/loop-store")

    for (const task of Cortex.list()) {
      if (task.owner?.kind !== "workflow_run" || task.owner.runID !== run.id) continue
      if (task.status !== "running" && task.status !== "queued" && task.status !== "pending") continue
      await Cortex.cancel(task.id).catch(() => undefined)
    }

    const sessionIDs = new Set<string>([run.bossSessionID])
    for (const seat of run.seats) {
      if (seat.sessionID) sessionIDs.add(seat.sessionID)
    }
    for (const entity of run.entities) {
      if (entity.bindings.seatSessionID) sessionIDs.add(entity.bindings.seatSessionID)
    }
    for (const sessionID of sessionIDs) {
      SessionInvoke.cancel(sessionID)
    }

    const loops = await BlueprintLoopStore.list(scopeID).catch(() => [])
    for (const loop of loops) {
      if (loop.source !== "workflow") continue
      if (loop.status === "completed" || loop.status === "failed" || loop.status === "cancelled") continue
      const owned = run.entities.some((entity) => entity.bindings.loopID === loop.id)
      if (!owned) continue
      await BlueprintLoopStore.updateStatus(scopeID, loop.id, {
        status: "cancelled",
        error: "workflow run cancelled",
      }).catch(() => undefined)
    }
  }

  export async function resolveGate(input: {
    runID: string
    gateInstanceID: string
    resolution: string
    resolvedBy: "human_ui" | "boss_agent"
  }): Promise<WorkflowTypes.Run> {
    const scopeID = ScopeContext.current.scope.id
    return WorkflowMachine.resolveGate({ scopeID, ...input })
  }

  /** Boss-driven intent (e.g. unblock a blocked entity by re-driving a transition). */
  export async function bossIntent(input: {
    runID: string
    entityID: string
    transitionID: string
    bossSessionID: string
  }): Promise<WorkflowMachine.IntentResult> {
    const scopeID = ScopeContext.current.scope.id
    return WorkflowMachine.submitIntent({
      scopeID,
      runID: input.runID,
      entityID: input.entityID,
      transitionID: input.transitionID,
      actorSessionID: input.bossSessionID,
      fromBoss: true,
    })
  }
}
