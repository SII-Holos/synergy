import { Cortex } from "../cortex"
import { Session } from "../session"
import { SessionInbox } from "../session/inbox"
import { SessionManager } from "../session/manager"
import type { Info as SessionInfo } from "../session/types"
import { Storage } from "../storage/storage"
import { Log } from "../util/log"
import { WorkflowBridge } from "./bridge"
import { CharterStore } from "./charter-store"
import { WorkflowEffects } from "./effects"
import { WorkflowMachine } from "./machine"
import { WorkflowRunExecutor } from "./executor"
import { WorkflowRunStore } from "./store"
import { WorkflowTypes } from "./types"

export namespace WorkflowRunRecovery {
  const log = Log.create({ service: "workflow.recovery" })

  export async function reconcile(scopeID: string): Promise<void> {
    const runs = await WorkflowRunStore.list(scopeID)
    const runsByID = new Map(runs.map((run) => [run.id, run]))
    const terminalContractors = await scanWorkflowSessions(runsByID)
    for (const run of runs) {
      if (run.status !== "active") continue
      const viable = await reconcileSessions(scopeID, run)
      if (!viable) continue
      await WorkflowBridge.projectPersistedHandoffAcks(scopeID, run.id)
      for (const contractor of terminalContractors.get(run.id) ?? []) {
        await Cortex.publishRecoveredWorkflowTask(contractor)
      }
      for (const pending of run.pendingEffects ?? []) {
        await WorkflowRunExecutor.run(scopeID, run.id, async () => {
          const current = await WorkflowRunStore.getOrUndefined(scopeID, run.id)
          if (!current || current.status !== "active") return
          const item = current.pendingEffects?.find((candidate) => candidate.id === pending.id)
          if (!item) return
          const charter = await CharterStore.get(scopeID, current.charterRef.id, current.charterRef.version)
          await WorkflowEffects.runPending(
            {
              scopeID,
              runID: current.id,
              entityID: item.entityID,
              charter,
              transitionID: item.transitionID,
              transitionEventID: item.transitionEventID,
            },
            item.id,
          )
        }).catch((error) => {
          log.error("pending workflow effect recovery failed", { scopeID, runID: run.id, effectID: pending.id, error })
        })
      }
      await WorkflowMachine.redrivePending(scopeID, run.id).catch((error) => {
        log.error("workflow transition recovery redrive failed", { scopeID, runID: run.id, error })
      })
    }
  }

  async function scanWorkflowSessions(runsByID: Map<string, WorkflowTypes.Run>): Promise<Map<string, SessionInfo[]>> {
    const terminalContractors = new Map<string, SessionInfo[]>()
    for await (const session of Session.listAll()) {
      const binding = session.workflowRun
      const boundRun = binding ? runsByID.get(binding.runID) : undefined
      if (binding && (!boundRun || (binding.role === "boss" && WorkflowTypes.isTerminalRun(boundRun.status)))) {
        await Session.update(session.id, (draft) => {
          if (draft.workflowRun?.runID !== binding.runID) return
          draft.workflowRun = undefined
          if (boundRun && binding.role === "boss" && WorkflowTypes.isTerminalRun(boundRun.status)) {
            draft.controlProfile = boundRun.bossPreviousControlProfile
          }
        })
      }

      const cortex = session.cortex
      const owner = cortex?.owner
      if (
        owner?.kind !== "workflow_run" ||
        !owner.runID ||
        !runsByID.has(owner.runID) ||
        !cortex ||
        (cortex.status !== "completed" &&
          cortex.status !== "error" &&
          cortex.status !== "cancelled" &&
          cortex.status !== "interrupted")
      ) {
        continue
      }
      const sessions = terminalContractors.get(owner.runID) ?? []
      sessions.push(session)
      terminalContractors.set(owner.runID, sessions)
    }
    return terminalContractors
  }

  async function reconcileSessions(scopeID: string, run: WorkflowTypes.Run): Promise<boolean> {
    const boss = await getSessionOrUndefined(run.bossSessionID)
    if (!boss) {
      await failRun(scopeID, run, "Boss session no longer exists")
      return false
    }
    if (!boss.workflowRun) {
      await Session.update(boss.id, (draft) => {
        if (draft.workflowRun) return
        draft.controlProfile = run.bossControlProfile
        draft.workflowRun = { runID: run.id, role: "boss" }
      })
    } else if (boss.workflowRun.runID !== run.id || boss.workflowRun.role !== "boss") {
      await failRun(scopeID, run, "Boss session is bound to a different workflow run")
      return false
    }

    const missingSessionIDs = new Set<string>()
    for (const binding of run.seats) {
      if (!binding.sessionID) continue
      const seat = await getSessionOrUndefined(binding.sessionID)
      if (!seat) missingSessionIDs.add(binding.sessionID)
    }
    const needsLeaseRepair = run.seats.some((binding) => {
      if (!binding.entityID) return false
      const entity = run.entities.find((candidate) => candidate.id === binding.entityID)
      return entity?.assignedSeat?.seat !== binding.seat || entity.assignedSeat.instance !== binding.instance
    })
    const hasBrokenAssignment = run.entities.some((entity) => {
      if (!entity.assignedSeat) return false
      const target = run.seats.find(
        (binding) => binding.seat === entity.assignedSeat?.seat && binding.instance === entity.assignedSeat?.instance,
      )
      return target?.entityID !== entity.id
    })

    if (missingSessionIDs.size > 0 || needsLeaseRepair || hasBrokenAssignment) {
      await WorkflowRunStore.update(
        scopeID,
        run.id,
        (draft) => {
          const now = Date.now()
          for (const current of draft.seats) {
            if (current.entityID) {
              const entity = draft.entities.find((candidate) => candidate.id === current.entityID)
              const ownsLease =
                entity?.assignedSeat?.seat === current.seat && entity.assignedSeat.instance === current.instance
              if (!ownsLease) {
                current.lastEntityIDs = [
                  current.entityID,
                  ...current.lastEntityIDs.filter((entityID) => entityID !== current.entityID),
                ].slice(0, 20)
                current.entityID = undefined
                current.status = current.sessionID ? "idle" : "unbound"
              }
            }

            if (!current.sessionID || !missingSessionIDs.has(current.sessionID)) continue
            const entity = current.entityID
              ? draft.entities.find((candidate) => candidate.id === current.entityID)
              : undefined
            if (entity) {
              entity.state = WorkflowTypes.BLOCKED_STATE
              entity.blockedReason = "assigned seat session was lost during restart"
              entity.time.updated = now
              entity.time.stateEntered = now
              entity.assignedSeat = undefined
              delete entity.bindings.seatSessionID
            }
            current.sessionID = undefined
            current.entityID = undefined
            current.status = "unbound"
          }

          for (const entity of draft.entities) {
            if (!entity.assignedSeat) continue
            const target = draft.seats.find(
              (binding) =>
                binding.seat === entity.assignedSeat?.seat && binding.instance === entity.assignedSeat?.instance,
            )
            if (target?.entityID === entity.id) {
              if (target.sessionID) entity.bindings.seatSessionID = target.sessionID
              continue
            }
            entity.state = WorkflowTypes.BLOCKED_STATE
            entity.blockedReason = "assigned seat lease was inconsistent during restart"
            entity.time.updated = now
            entity.time.stateEntered = now
            entity.assignedSeat = undefined
            delete entity.bindings.seatSessionID
          }
        },
        { expectedRunStatus: "active" },
      )
    }

    const current = await WorkflowRunStore.getOrUndefined(scopeID, run.id)
    if (!current || current.status !== "active") return false
    for (const binding of current.seats) {
      if (!binding.sessionID || !binding.entityID) continue
      const entity = current.entities.find((candidate) => candidate.id === binding.entityID)
      if (entity?.assignedSeat?.seat !== binding.seat || entity.assignedSeat.instance !== binding.instance) continue
      if (SessionManager.isRunning(binding.sessionID)) continue
      if (!(await SessionInbox.hasRunnableItem(binding.sessionID))) continue
      SessionManager.scheduleWake(binding.sessionID, "workflow_recovery")
    }
    return true
  }

  async function failRun(scopeID: string, run: WorkflowTypes.Run, reason: string): Promise<void> {
    await WorkflowRunStore.update(
      scopeID,
      run.id,
      (draft) => {
        draft.status = "failed"
        draft.statusReason = reason
        draft.pendingEffects = []
        draft.time.completed = Date.now()
      },
      { expectedRunStatus: "active" },
    )
    await WorkflowRunStore.appendEvent(scopeID, run, { kind: "run_failed", message: reason })
  }

  async function getSessionOrUndefined(sessionID: string): Promise<Session.Info | undefined> {
    try {
      return await Session.get(sessionID)
    } catch (error) {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    }
  }
}
