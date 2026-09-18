import { SnapshotLifecycle } from "@ericsanchezok/synergy-harness/session/snapshot-lifecycle"
import fs from "fs/promises"
import path from "path"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { SessionEndpoint } from "@ericsanchezok/synergy-harness/session/endpoint"
import { SessionNav, type ScopeNavIndex } from "@ericsanchezok/synergy-harness/session/nav"
import type { Info, StatusInfo } from "@ericsanchezok/synergy-harness/session/types"
import { SessionProgress } from "@ericsanchezok/synergy-harness/session/progress"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionBlueprintState } from "./blueprint-state"
import { SessionNoteAccess } from "@ericsanchezok/synergy-note/session-contract"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { isActiveLightLoopWorkflow } from "./light-loop-state"

import { SessionRecovery } from "@ericsanchezok/synergy-harness/session/recovery"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { RolloutContinuationRecovery } from "@ericsanchezok/synergy-harness/session/rollout/continuation-recovery"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

export namespace WorkflowRecovery {
  const log = Log.create({ service: "workflow.recovery" })
  const TERMINAL_LOOP_STATUSES = new Set<SessionBlueprintState.LoopStatus>(["completed", "failed", "cancelled"])

  /** Stable prefix marking a loop terminalized by restart adjudication rather
   * than by its own lifecycle, so operators can distinguish the two. */
  const INTERRUPTED_PREFIX = "interrupted:"

  function isActiveLoop(loop: SessionBlueprintState.LoopInfo | undefined) {
    return !!loop && SessionBlueprintState.isActiveStatus(loop.status)
  }

  function isTerminalLoop(loop: SessionBlueprintState.LoopInfo | undefined) {
    return !!loop && TERMINAL_LOOP_STATUSES.has(loop.status)
  }

  /**
   * Whether an active loop has durable evidence that something will resume it.
   * Exported so an explicit user stop can reuse the identical test: a loop kept
   * alive by real evidence must never be abandoned by an abort.
   */
  export async function hasResumableEvidence(loop: SessionBlueprintState.LoopInfo): Promise<boolean> {
    return hasDurableDriver({ loop, sessionID: loop.sessionID })
  }

  /** Whether the session itself carries queued work that will be driven. */
  export async function sessionHasDurableDriver(sessionID: string): Promise<boolean> {
    if (await SessionInbox.hasRunnableItem(sessionID).catch(() => false)) return true
    return RolloutContinuationRecovery.pending(sessionID).catch(() => false)
  }

  /**
   * A persisted active loop is only a real driver when something durable will
   * resume it after a restart. A loop without such evidence is a phantom: it
   * keeps the session pinned in `recovering` while nothing drives it, and no
   * user-facing control can clear it because the derived status is recomputed
   * from this very record.
   */
  async function hasDurableDriver(input: {
    loop: SessionBlueprintState.LoopInfo
    sessionID: string | undefined
  }): Promise<boolean> {
    const { loop } = input
    // A user-paused loop waits for an explicit resume, not for a driver.
    if (loop.status === "waiting") return true
    // Stop-intent recovery re-drives the execution session before this loop
    // would need a fresh driver (see resumePendingStopRequests).
    if (loop.stopRequest) return true
    // Lattice creates, starts, and reconciles its own loops through its own
    // startup controller, which runs after session recovery.
    if (loop.source === "lattice") return true
    if (!input.sessionID) return false
    if (await SessionInbox.hasRunnableItem(input.sessionID).catch(() => false)) return true
    return RolloutContinuationRecovery.pending(input.sessionID).catch(() => false)
  }

  /** Stable prefix for a loop an operator or recovery ended before its own
   * lifecycle finished, so the two are distinguishable in stored history. */
  export const INTERRUPTED_LOOP_ERROR = `${INTERRUPTED_PREFIX} runtime restarted before this loop resumed`

  /**
   * End a loop on explicit user request. Cancellation is the honest terminal
   * status here — unlike restart adjudication, nothing was interrupted in
   * flight; the user asked for it to stop.
   */
  export async function abandonLoop(scopeID: string, loopID: string): Promise<void> {
    await SessionBlueprintState.updateLoopStatus(scopeID, loopID, {
      status: "cancelled",
      error: "Stopped by user request",
    })
  }

  /**
   * Terminalize a loop that has no resumable evidence. Returns the terminal
   * status applied, or undefined when the loop is preserved. `armed` has no
   * in-flight work to fail and its only legal terminal transition is
   * `cancelled`; a started loop is honestly `failed`.
   */
  async function adjudicateOrphanedLoop(input: {
    scopeID: string
    loop: SessionBlueprintState.LoopInfo
    apply: boolean
    report: SessionRecovery.RuntimeReconcileReport
  }): Promise<SessionBlueprintState.LoopStatus | undefined> {
    const { loop } = input
    if (await hasResumableEvidence(loop)) return undefined

    const status: SessionBlueprintState.LoopStatus = loop.status === "armed" ? "cancelled" : "failed"
    if (!input.apply) {
      reportChange(input.report, { scopeID: input.scopeID, loopID: loop.id, action: `orphaned_loop_would_${status}` })
      return status
    }
    try {
      await SessionBlueprintState.updateLoopStatus(input.scopeID, loop.id, {
        status,
        error: `${INTERRUPTED_PREFIX} runtime restarted before this loop resumed`,
      })
    } catch (error) {
      // A concurrent writer already moved the loop (or removed it); that actor
      // owns the outcome, and the next reconcile pass re-adjudicates the rest.
      log.warn("orphaned BlueprintLoop adjudication lost the record", {
        scopeID: input.scopeID,
        loopID: loop.id,
        error: String(error),
      })
      return undefined
    }
    reportChange(input.report, { scopeID: input.scopeID, loopID: loop.id, action: `orphaned_loop_${status}` })
    return status
  }

  function isWorkflowRecoveryCandidate(session: Info) {
    return isActiveLightLoopWorkflow(session.workflow) || session.workflow?.kind === "lattice"
  }

  function isSessionRecoveryCandidate(session: Info) {
    if (session.time.archived) return false
    return session.pendingReply === true || !!session.blueprint?.loopID || isWorkflowRecoveryCandidate(session)
  }

  export async function scopeIDsForRuntimeRecovery(scopeID?: string): Promise<string[]> {
    if (scopeID) return [scopeID]
    const ids = new Set<string>()
    for (const id of await Storage.scan(["sessions"]).catch(() => [])) ids.add(id)
    for (const id of await Storage.scan(["blueprint_loops"]).catch(() => [])) ids.add(id)
    return [...ids].sort()
  }

  async function sessionInfos(scopeID: string): Promise<Info[]> {
    const result: Info[] = []
    for await (const record of Storage.records<Info>({ kind: "session", scopeID })) {
      if (record.value?.scope) result.push(record.value)
    }
    return result
  }

  function reportChange(
    report: SessionRecovery.RuntimeReconcileReport,
    input: { scopeID: string; sessionID?: string; noteID?: string; loopID?: string; action: string },
  ) {
    report.changed++
    report.entries.push(input)
  }

  async function reconcileNoteActiveLoop(input: {
    scopeID: string
    loop: SessionBlueprintState.LoopInfo
    apply: boolean
    report: SessionRecovery.RuntimeReconcileReport
  }) {
    const note = await SessionNoteAccess.getBlueprintNote(input.scopeID, input.loop.noteID)
    if (!note) return
    if (note.activeLoopID === input.loop.id) return

    if (input.apply) {
      await SessionNoteAccess.setBlueprintActiveLoop(input.scopeID, input.loop.noteID, input.loop.id)
    }
    reportChange(input.report, {
      scopeID: input.scopeID,
      loopID: input.loop.id,
      action: "note_active_loop_restored",
    })
  }

  async function clearNoteActiveLoop(input: {
    scopeID: string
    loop: SessionBlueprintState.LoopInfo
    apply: boolean
    report: SessionRecovery.RuntimeReconcileReport
  }) {
    const note = await SessionNoteAccess.getBlueprintNote(input.scopeID, input.loop.noteID)
    if (!note || note.activeLoopID !== input.loop.id) return

    if (input.apply) {
      await SessionNoteAccess.setBlueprintActiveLoop(input.scopeID, input.loop.noteID, null)
    }
    reportChange(input.report, {
      scopeID: input.scopeID,
      loopID: input.loop.id,
      action: "note_terminal_loop_cleared",
    })
  }

  async function ensureSessionLoopBinding(input: {
    scopeID: string
    sessionID: string | undefined
    loopID: string
    loopRole: "execution" | "audit"
    apply: boolean
    report: SessionRecovery.RuntimeReconcileReport
  }) {
    if (!input.sessionID) return
    const session = await Storage.read<Info>(
      StoragePath.sessionInfo(Identifier.asScopeID(input.scopeID), Identifier.asSessionID(input.sessionID)),
    ).catch(() => undefined)
    if (!session || session.time.archived) return
    if (session.blueprint?.loopID === input.loopID && session.blueprint?.loopRole === input.loopRole) return

    if (input.apply) {
      await Session.update(input.sessionID, (draft) => {
        draft.blueprint = { ...draft.blueprint, loopID: input.loopID, loopRole: input.loopRole }
      })
    }
    reportChange(input.report, {
      scopeID: input.scopeID,
      sessionID: input.sessionID,
      loopID: input.loopID,
      action: `session_${input.loopRole}_loop_restored`,
    })
  }

  async function clearSessionLoopBinding(input: {
    scopeID: string
    sessionID: string | undefined
    loopID: string
    apply: boolean
    report: SessionRecovery.RuntimeReconcileReport
  }) {
    if (!input.sessionID) return
    const session = await Storage.read<Info>(
      StoragePath.sessionInfo(Identifier.asScopeID(input.scopeID), Identifier.asSessionID(input.sessionID)),
    ).catch(() => undefined)
    if (!session || session.blueprint?.loopID !== input.loopID) return

    if (input.apply) {
      await Session.update(input.sessionID, (draft) => {
        draft.blueprint = { ...draft.blueprint, loopID: undefined, loopRole: undefined }
      })
    }
    reportChange(input.report, {
      scopeID: input.scopeID,
      sessionID: input.sessionID,
      loopID: input.loopID,
      action: "session_terminal_loop_cleared",
    })
  }

  async function reconcileSessionBlueprintReference(input: {
    scopeID: string
    session: Info
    loops: Map<string, SessionBlueprintState.LoopInfo>
    apply: boolean
    report: SessionRecovery.RuntimeReconcileReport
  }) {
    const loopID = input.session.blueprint?.loopID
    if (!loopID) return
    const loop = input.loops.get(loopID)
    if (isActiveLoop(loop)) return

    if (input.apply) {
      await Session.update(input.session.id, (draft) => {
        draft.blueprint = { ...draft.blueprint, loopID: undefined, loopRole: undefined }
      })
    }
    reportChange(input.report, {
      scopeID: input.scopeID,
      sessionID: input.session.id,
      loopID,
      action: loop ? "session_inactive_loop_cleared" : "session_missing_loop_cleared",
    })
  }

  async function reconcileNoteBlueprintReferences(input: {
    scopeID: string
    loops: Map<string, SessionBlueprintState.LoopInfo>
    apply: boolean
    report: SessionRecovery.RuntimeReconcileReport
  }) {
    const notes = await SessionNoteAccess.listBlueprintNotes(input.scopeID)
    for (const note of notes) {
      const loopID = note.activeLoopID
      if (!loopID) continue
      const loop = input.loops.get(loopID)
      if (isActiveLoop(loop)) continue

      if (input.apply) {
        await SessionNoteAccess.setBlueprintActiveLoop(input.scopeID, note.noteID, null)
      }
      reportChange(input.report, {
        scopeID: input.scopeID,
        noteID: note.noteID,
        loopID,
        action: loop ? "note_inactive_loop_cleared" : "note_missing_loop_cleared",
      })
    }
  }

  export async function reconcileRuntimeScope(input: {
    scopeID: string
    apply: boolean
    report: SessionRecovery.RuntimeReconcileReport
  }) {
    const [sessions, listedLoops] = await Promise.all([
      sessionInfos(input.scopeID),
      SessionBlueprintState.listLoops(input.scopeID),
    ])
    input.report.loopsScanned += listedLoops.length

    // Adjudicate before restoring bindings: a loop with no resumable evidence
    // must become terminal here, so that the binding and note-reference logic
    // below sees its terminal state and clears the references pinning the
    // session. Restoring first, then adjudicating, would rebuild exactly the
    // references that must go away.
    const loops = [...listedLoops]
    for (let index = 0; index < loops.length; index++) {
      const loop = loops[index]!
      if (!isActiveLoop(loop)) continue
      const terminal = await adjudicateOrphanedLoop({ ...input, loop })
      if (terminal) loops[index] = { ...loop, status: terminal }
    }

    const loopsByID = new Map(loops.map((loop) => [loop.id, loop]))
    const sessionsByID = new Map(sessions.map((session) => [session.id, session]))
    const sessionCandidates = new Map<string, Info>()
    for (const session of sessions) {
      if (isSessionRecoveryCandidate(session)) sessionCandidates.set(session.id, session)
    }

    for (const loop of loops) {
      if (isActiveLoop(loop)) {
        await reconcileNoteActiveLoop({ ...input, loop })
        await ensureSessionLoopBinding({
          ...input,
          sessionID: loop.sessionID,
          loopID: loop.id,
          loopRole: "execution",
        })
        if (loop.status === "auditing") {
          await ensureSessionLoopBinding({
            ...input,
            sessionID: loop.auditSessionID,
            loopID: loop.id,
            loopRole: "audit",
          })
        }
      } else if (isTerminalLoop(loop)) {
        await clearNoteActiveLoop({ ...input, loop })
        await clearSessionLoopBinding({ ...input, sessionID: loop.sessionID, loopID: loop.id })
        await clearSessionLoopBinding({ ...input, sessionID: loop.auditSessionID, loopID: loop.id })
      }
      const execution = sessionsByID.get(loop.sessionID)
      if (execution) sessionCandidates.set(execution.id, execution)
      if (loop.auditSessionID) {
        const audit = sessionsByID.get(loop.auditSessionID)
        if (audit) sessionCandidates.set(audit.id, audit)
      }
    }

    for (const session of sessionCandidates.values()) {
      await reconcileSessionBlueprintReference({ ...input, session, loops: loopsByID })
    }
    await reconcileNoteBlueprintReferences({ ...input, loops: loopsByID })
  }

  export async function resumePendingStopRequests(targetScopeID?: string): Promise<number> {
    let requested = 0
    for (const scopeID of await scopeIDsForRuntimeRecovery(targetScopeID)) {
      const [sessions, loops] = await Promise.all([sessionInfos(scopeID), SessionBlueprintState.listLoops(scopeID)])
      const sessionsByID = new Map(sessions.map((session) => [session.id, session]))
      const pending = new Map<string, Info>()

      for (const session of sessions) {
        if (!session.time || session.time.archived || !isActiveLightLoopWorkflow(session.workflow)) continue
        const stopRequest = session.workflow.stopRequest
        if (!stopRequest) continue
        if (stopRequest.reviewSessionID) {
          const reviewer = sessionsByID.get(stopRequest.reviewSessionID)
          if (reviewer?.cortex?.status === "interrupted") {
            await Session.update(session.id, (draft) => {
              if (draft.workflow?.kind !== "lightloop") return
              const current = draft.workflow.stopRequest
              if (!current || current.reviewSessionID !== stopRequest.reviewSessionID) return
              current.reviewTaskID = undefined
              current.reviewSessionID = undefined
            })
          } else if (reviewer?.cortex?.status !== "completed") {
            continue
          }
        }
        pending.set(session.id, session)
      }

      for (const loop of loops) {
        if (!loop.stopRequest) continue
        if (loop.status === "auditing" && loop.auditSessionID) {
          const reviewer = sessionsByID.get(loop.auditSessionID)
          if (reviewer?.cortex?.status === "interrupted") {
            await SessionBlueprintState.updateLoopStatus(scopeID, loop.id, {
              status: "running",
              auditSessionID: null,
              auditTaskID: null,
              stopRequest: loop.stopRequest,
            })
          } else if (reviewer?.cortex?.status !== "completed") {
            continue
          }
        } else if (loop.status !== "running") {
          continue
        }
        const execution = sessionsByID.get(loop.sessionID)
        if (execution?.time && !execution.time.archived) pending.set(execution.id, execution)
      }

      for (const session of pending.values()) {
        await ScopeContext.provide({
          scope: session.scope,
          fn: async () => {
            const { SessionDrive } = await import("@ericsanchezok/synergy-harness/session/drive")
            await SessionDrive.request(session.id, "stop-review-recovery")
          },
        })
        requested++
      }
    }
    return requested
  }

  export async function recoverableStatuses(scopeID: string): Promise<Record<string, StatusInfo>> {
    const { resolve, toStatus } = await import("@ericsanchezok/synergy-harness/session/working")
    const [sessions, loops] = await Promise.all([sessionInfos(scopeID), SessionBlueprintState.listLoops(scopeID)])
    const sessionsByID = new Map(sessions.map((session) => [session.id, session]))
    const candidates = new Map<string, Info>()
    const activeLoopSessionIDs = new Set<string>()
    for (const session of sessions) {
      if (isSessionRecoveryCandidate(session)) candidates.set(session.id, session)
    }
    for (const loop of loops) {
      if (!isActiveLoop(loop)) continue
      const execution = sessionsByID.get(loop.sessionID)
      if (execution) {
        candidates.set(execution.id, execution)
        activeLoopSessionIDs.add(execution.id)
      }
      if (loop.auditSessionID) {
        const audit = sessionsByID.get(loop.auditSessionID)
        if (audit) {
          candidates.set(audit.id, audit)
          activeLoopSessionIDs.add(audit.id)
        }
      }
    }

    const result: Record<string, StatusInfo> = {}
    for (const session of candidates.values()) {
      const working = await resolve(session.id).catch(() => undefined)
      if (working) {
        result[session.id] = toStatus(working)
      } else if (activeLoopSessionIDs.has(session.id)) {
        result[session.id] = { type: "recovering", reason: "workflow", description: "BlueprintLoop active" }
      }
    }
    return result
  }
}
