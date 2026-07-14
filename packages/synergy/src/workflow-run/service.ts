import { Identifier } from "../id/id"
import { ScopeContext } from "../scope/context"
import { Session } from "../session"
import { Storage } from "../storage/storage"
import { Agent } from "../agent/agent"
import { CharterStore } from "./charter-store"
import { IssueToPrCharter } from "./builtin/issue-to-pr"
import { WorkflowError } from "./error"
import { WorkflowRunExecutor } from "./executor"
import { WorkflowMachine } from "./machine"
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
    bossControlProfile?: NonNullable<Session.Info["controlProfile"]>
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
      throw new WorkflowError.NotAuthorized({ reason: "Boss session is not in the current scope" })
    }
    let replaceableBossRunID: string | undefined
    let replaceableBossRun: WorkflowTypes.Run | undefined
    if (boss.workflowRun) {
      const boundRun = await WorkflowRunStore.getOrUndefined(scopeID, boss.workflowRun.runID)
      const ownsTerminalRun =
        boss.workflowRun.role === "boss" &&
        (!boundRun || (boundRun.bossSessionID === boss.id && WorkflowTypes.isTerminalRun(boundRun.status)))
      if (!ownsTerminalRun) {
        throw new WorkflowError.TransitionRejected({
          reason: `Session ${input.bossSessionID} is already bound to workflow run ${boss.workflowRun.runID}`,
        })
      }
      replaceableBossRunID = boss.workflowRun.runID
      replaceableBossRun = boundRun
    }
    const bossAgent = boss.agentOverride ? await Agent.get(boss.agentOverride) : undefined
    const bossControlProfile =
      replaceableBossRun?.bossPreviousControlProfile ??
      replaceableBossRun?.bossControlProfile ??
      input.bossControlProfile ??
      (await Session.resolveEffectiveControlProfile({
        sessionID: boss.id,
        agentControlProfile: bossAgent?.controlProfile,
      }))
    const runID = Identifier.ascending("workflow_run")
    let rollbackBossControlProfile: Session.Info["controlProfile"]
    let runPreviousBossControlProfile: Session.Info["controlProfile"]
    let previousBossWorkflowRun: Session.Info["workflowRun"]
    await Session.update(input.bossSessionID, (draft) => {
      if (draft.scope.id !== scopeID) {
        throw new WorkflowError.NotAuthorized({ reason: "Boss session is not in the current scope" })
      }
      if (draft.workflowRun) {
        const replacesTerminalBossRun =
          draft.workflowRun.role === "boss" && draft.workflowRun.runID === replaceableBossRunID
        if (!replacesTerminalBossRun) {
          throw new WorkflowError.TransitionRejected({
            reason: `Session ${input.bossSessionID} is already bound to workflow run ${draft.workflowRun.runID}`,
          })
        }
      }
      rollbackBossControlProfile = draft.controlProfile
      runPreviousBossControlProfile = replaceableBossRun
        ? replaceableBossRun.bossPreviousControlProfile
        : draft.controlProfile
      previousBossWorkflowRun = draft.workflowRun
      draft.controlProfile = bossControlProfile
      draft.workflowRun = { runID, role: "boss" }
    })
    try {
      const run = await WorkflowRunStore.create({
        id: runID,
        scopeID,
        charterRef: { id: charter.id, version: charter.version },
        title: input.title,
        bossSessionID: input.bossSessionID,
        bossControlProfile,
        bossPreviousControlProfile: runPreviousBossControlProfile,
        seats: WorkflowSeats.initialBindings(charter),
        maxModelCalls: input.maxModelCalls ?? charter.budget.maxModelCalls,
      })
      return WorkflowSeats.withProjectedStatus(run)
    } catch (error) {
      const created = await WorkflowRunStore.getOrUndefined(scopeID, runID)
      if (created) return WorkflowSeats.withProjectedStatus(created)
      try {
        await Session.update(input.bossSessionID, (draft) => {
          if (draft.workflowRun?.runID !== runID) return
          draft.workflowRun = previousBossWorkflowRun
          draft.controlProfile = rollbackBossControlProfile
        })
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Failed to roll back workflow run ${runID} creation`)
      }
      throw error
    }
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
    if (run.status !== "active") {
      throw new WorkflowError.TransitionRejected({ reason: `run is ${run.status}, not active` })
    }
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
    await WorkflowRunStore.update(
      scopeID,
      input.runID,
      (draft) => {
        draft.entities.push(entity)
      },
      { expectedRunStatus: "active" },
    )
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
    const result = await WorkflowRunExecutor.run(scopeID, runID, async () => {
      const run = await WorkflowRunStore.getOrUndefined(scopeID, runID)
      if (!run) throw new WorkflowError.RunNotFound({ runID })

      if (action === "pause") {
        if (run.status === "paused") return { run, resumed: false }
        if (run.status !== "active") {
          throw new WorkflowError.TransitionRejected({ reason: `run is ${run.status}, not pausable` })
        }
        const updated = await WorkflowRunStore.update(
          scopeID,
          runID,
          (draft) => {
            draft.status = "paused"
            draft.statusReason = "user_paused"
          },
          { expectedRunStatus: "active" },
        )
        await WorkflowRunStore.appendEvent(scopeID, { id: runID }, { kind: "run_paused", message: "user_paused" })
        return { run: updated, resumed: false }
      }
      if (action === "resume") {
        if (run.status === "active") return { run, resumed: false }
        if (run.status !== "paused") {
          throw new WorkflowError.TransitionRejected({ reason: `run is ${run.status}, not resumable` })
        }
        const updated = await WorkflowRunStore.update(
          scopeID,
          runID,
          (draft) => {
            draft.status = "active"
            draft.statusReason = undefined
          },
          { expectedRunStatus: "paused" },
        )
        await WorkflowRunStore.appendEvent(scopeID, { id: runID }, { kind: "run_resumed" })
        return { run: updated, resumed: true }
      }

      if (run.status === "cancelled") {
        await stopRunExecution(scopeID, run)
        return { run, resumed: false }
      }
      if (WorkflowTypes.isTerminalRun(run.status)) {
        throw new WorkflowError.TransitionRejected({ reason: `run is ${run.status}, not cancellable` })
      }
      const updated = await WorkflowRunStore.update(
        scopeID,
        runID,
        (draft) => {
          const now = Date.now()
          draft.status = "cancelled"
          draft.statusReason = "user_cancelled"
          draft.time.completed = now
          draft.pendingEffects = []
          for (const seat of draft.seats) {
            seat.status = seat.sessionID ? "idle" : "unbound"
            seat.entityID = undefined
          }
          for (const entity of draft.entities) {
            const hadLease =
              entity.assignedSeat !== undefined ||
              entity.bindings.seatSessionID !== undefined ||
              entity.pendingHandoffID !== undefined
            entity.assignedSeat = undefined
            delete entity.bindings.seatSessionID
            entity.pendingHandoffID = undefined
            if (hadLease) entity.time.updated = now
          }
        },
        { expectedRunStatus: ["active", "paused"] },
      )
      await stopRunExecution(scopeID, run)
      await WorkflowRunStore.appendEvent(scopeID, { id: runID }, { kind: "run_cancelled" })
      return { run: updated, resumed: false }
    })
    if (action === "cancel") await clearBossBinding(result.run)
    if (result.resumed) {
      for (const entity of result.run.entities) {
        await WorkflowMachine.evaluateEventTransitions(scopeID, runID, entity.id).catch(() => undefined)
      }
    }
    return WorkflowSeats.withProjectedStatus(result.run)
  }

  async function clearBossBinding(run: WorkflowTypes.Run): Promise<void> {
    try {
      await Session.update(run.bossSessionID, (draft) => {
        if (draft.workflowRun?.role !== "boss" || draft.workflowRun.runID !== run.id) return
        draft.workflowRun = undefined
        draft.controlProfile = run.bossPreviousControlProfile
      })
    } catch (error) {
      if (error instanceof Storage.NotFoundError) return
      throw error
    }
  }

  async function stopRunExecution(scopeID: string, run: WorkflowTypes.Run): Promise<void> {
    const { Cortex } = await import("../cortex")
    const { SessionInbox } = await import("../session/inbox")
    const { SessionInvoke } = await import("../session/invoke")
    const { BlueprintLoopStore } = await import("../blueprint/loop-store")

    for (const task of Cortex.list()) {
      if (task.owner?.kind !== "workflow_run" || task.owner.runID !== run.id) continue
      if (task.status !== "running" && task.status !== "queued") continue
      await Cortex.cancel(task.id).catch(() => undefined)
    }

    const sessionIDs = new Set<string>()
    for (const seat of run.seats) {
      if (seat.sessionID) sessionIDs.add(seat.sessionID)
    }
    for (const entity of run.entities) {
      if (entity.bindings.seatSessionID) sessionIDs.add(entity.bindings.seatSessionID)
    }
    for (const sessionID of sessionIDs) {
      const items = await SessionInbox.list(sessionID).catch(() => [])
      for (const item of items) {
        if (workflowRunID(item.message?.metadata) !== run.id) continue
        await SessionInbox.remove({ sessionID, itemID: item.id }).catch(() => undefined)
      }
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

  function workflowRunID(metadata: unknown): string | undefined {
    if (!metadata || typeof metadata !== "object") return undefined
    const workflow = (metadata as Record<string, unknown>).workflowRun
    if (!workflow || typeof workflow !== "object") return undefined
    const runID = (workflow as Record<string, unknown>).runID
    return typeof runID === "string" ? runID : undefined
  }

  export async function resolveGate(input: {
    runID: string
    gateInstanceID: string
    resolution: string
    resolvedBy: "human_ui" | "boss_agent"
  }): Promise<WorkflowTypes.Run> {
    const scopeID = ScopeContext.current.scope.id
    return WorkflowSeats.withProjectedStatus(await WorkflowMachine.resolveGate({ scopeID, ...input }))
  }

  /** Boss-driven intent (e.g. unblock a blocked entity by re-driving a transition). */
  export async function bossIntent(input: {
    runID: string
    entityID: string
    transitionID: string
    bossSessionID: string
  }): Promise<WorkflowMachine.IntentResult> {
    const scopeID = ScopeContext.current.scope.id
    const run = await WorkflowRunStore.get(scopeID, input.runID)
    if (run.bossSessionID !== input.bossSessionID) {
      throw new WorkflowError.NotAuthorized({ reason: "Boss session does not own this workflow run" })
    }
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
