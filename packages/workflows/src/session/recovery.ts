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
import { isActiveLightLoopWorkflow } from "./light-loop-state"

import { SessionRecovery } from "@ericsanchezok/synergy-harness/session/recovery"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionInbox } from "@ericsanchezok/synergy-harness/session/inbox"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { SessionWorkflowHold } from "@ericsanchezok/synergy-harness/session/workflow-hold"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

export namespace WorkflowRecovery {
  const log = Log.create({ service: "workflow.recovery" })
  const TERMINAL_LOOP_STATUSES = new Set<SessionBlueprintState.LoopStatus>(["completed", "failed", "cancelled"])

  function isActiveLoop(loop: SessionBlueprintState.LoopInfo | undefined) {
    return !!loop && SessionBlueprintState.isActiveStatus(loop.status)
  }

  function isTerminalLoop(loop: SessionBlueprintState.LoopInfo | undefined) {
    return !!loop && TERMINAL_LOOP_STATUSES.has(loop.status)
  }

  /** Whether the session itself carries queued work that will be driven. */
  export async function sessionHasDurableDriver(sessionID: string): Promise<boolean> {
    return SessionInbox.hasRunnableItem(sessionID)
  }

  /**
   * A persisted active loop is only a real driver when something will resume it
   * after a restart. A loop without such evidence is orphaned: it pins the
   * session while nothing drives it, so adjudication stops the session and
   * leaves the loop record for the user to continue or abandon.
   */
  async function hasDurableDriver(input: {
    loop: SessionBlueprintState.LoopInfo
    sessionID: string | undefined
  }): Promise<boolean> {
    const { loop } = input
    // A pending review request means a verdict is still owed: the review
    // session's completion re-enters the loop through the continuation kernel.
    if (loop.stopRequest) return true
    // Lattice creates, starts, and reconciles its own loops through its own
    // startup controller, which runs after session recovery.
    if (loop.source === "lattice") return true
    if (!input.sessionID) return false
    // A live runtime is driving this loop right now. Recovery normally runs
    // before anything is running, but a re-ensured scope can reconcile while
    // sessions are live, and a loop under a running turn is by definition not
    // orphaned however empty its durable queues look.
    if (SessionManager.isRunning(input.sessionID)) return true
    return sessionHasDurableDriver(input.sessionID)
  }

  /**
   * End a loop on explicit user request. Cancellation is the honest terminal
   * status here: nothing failed, the user asked for the work to stop.
   */
  export async function abandonLoop(scopeID: string, loopID: string): Promise<void> {
    await SessionBlueprintState.updateLoopStatus(scopeID, loopID, {
      status: "cancelled",
      error: "Stopped by user request",
    })
  }

  /**
   * Stop the session of a loop nothing will resume.
   *
   * The loop record is left exactly as stored: a restart is evidence that the
   * turn stopped, not that the user's work should be destroyed, and that record
   * is the only handle left for continuing it. The pause latch is what makes the
   * state honest and actionable — the session stops, names the workflow holding
   * it, and the user chooses between continuing and abandoning the work.
   */
  async function adjudicateOrphanedLoop(input: {
    scopeID: string
    loop: SessionBlueprintState.LoopInfo
    apply: boolean
    report: SessionRecovery.RuntimeReconcileReport
  }): Promise<void> {
    const { loop } = input
    if (await hasDurableDriver({ loop, sessionID: loop.sessionID })) return

    if (!input.apply) {
      reportChange(input.report, {
        scopeID: input.scopeID,
        sessionID: loop.sessionID,
        loopID: loop.id,
        action: "paused_session_would_be_set",
      })
      return
    }

    const paused = await SessionLifecycle.pause({
      sessionID: loop.sessionID,
      reason: "workflow",
      description: SessionWorkflowHold.DESCRIPTION,
    }).catch((error) => {
      log.warn("orphaned BlueprintLoop session pause failed", {
        scopeID: input.scopeID,
        loopID: loop.id,
        error: String(error),
      })
      return false
    })
    if (!paused) return
    reportChange(input.report, {
      scopeID: input.scopeID,
      sessionID: loop.sessionID,
      loopID: loop.id,
      action: "paused_session_set",
    })
  }

  function isWorkflowRecoveryCandidate(session: Info) {
    return isActiveLightLoopWorkflow(session.workflow) || session.workflow?.kind === "lattice"
  }

  /**
   * A session worth reconciling: it carries a pause latch, meaning it stopped
   * and awaits the user, or it still has a live workflow binding. A binding
   * alone is enough because clearing a stale reference to a terminal loop must
   * not depend on a latch.
   */
  function isSessionRecoveryCandidate(session: Info) {
    if (session.time.archived) return false
    return session.paused !== undefined || !!session.blueprint?.loopID || isWorkflowRecoveryCandidate(session)
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
        draft.blueprint = { ...draft.blueprint, loopID: undefined, loopRole: undefined, phase: undefined }
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
        draft.blueprint = { ...draft.blueprint, loopID: undefined, loopRole: undefined, phase: undefined }
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

    // A loop nothing will resume holds its session: stop that session, and keep
    // the loop record so the user can still continue or abandon the work.
    const loops = listedLoops
    for (const loop of loops) {
      if (!isActiveLoop(loop)) continue
      await adjudicateOrphanedLoop({ ...input, loop })
    }

    const loopsByID = new Map(loops.map((loop) => [loop.id, loop]))
    const sessionsByID = new Map(sessions.map((session) => [session.id, session]))
    const sessionCandidates = new Map<string, Info>()
    for (const session of sessions) {
      if (isSessionRecoveryCandidate(session)) sessionCandidates.set(session.id, session)
    }

    for (const loop of loops) {
      // Contain a failure per loop: adjudication for this loop is already
      // committed, so one unrecoverable reference cleanup must not starve every
      // later loop of its own cleanup on this pass and every pass after it.
      try {
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
      } catch (error) {
        log.warn("BlueprintLoop reference reconciliation failed", {
          scopeID: input.scopeID,
          loopID: loop.id,
          error: String(error),
        })
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

  /**
   * Statuses recovery is responsible for, keyed by session id.
   *
   * A workflow projects no status of its own: with the session as the single
   * pause authority, a persisted loop is a record of intent rather than evidence
   * of work. The only status reported for a bound session is the pause the
   * session itself carries, and a session with neither a latch nor a live turn
   * reports nothing at all.
   */
  export async function recoverableStatuses(scopeID: string): Promise<Record<string, StatusInfo>> {
    const { resolve, toStatus } = await import("@ericsanchezok/synergy-harness/session/working")
    const [sessions, loops] = await Promise.all([sessionInfos(scopeID), SessionBlueprintState.listLoops(scopeID)])
    const sessionsByID = new Map(sessions.map((session) => [session.id, session]))
    const candidates = new Map<string, Info>()
    // The loop that binds each session, so the fallback below can tell a bound
    // session from an unbound one.
    const activeLoopBySessionID = new Map<string, SessionBlueprintState.LoopInfo>()
    for (const session of sessions) {
      if (isSessionRecoveryCandidate(session)) candidates.set(session.id, session)
    }
    for (const loop of loops) {
      if (!isActiveLoop(loop)) continue
      const execution = sessionsByID.get(loop.sessionID)
      if (execution) {
        candidates.set(execution.id, execution)
        activeLoopBySessionID.set(execution.id, loop)
      }
      if (loop.auditSessionID) {
        const audit = sessionsByID.get(loop.auditSessionID)
        if (audit) {
          candidates.set(audit.id, audit)
          activeLoopBySessionID.set(audit.id, loop)
        }
      }
    }

    const result: Record<string, StatusInfo> = {}
    for (const session of candidates.values()) {
      const working = await resolve(session.id).catch(() => undefined)
      if (working) {
        result[session.id] = toStatus(working)
        continue
      }
      if (!activeLoopBySessionID.has(session.id)) continue
      const paused = await SessionLifecycle.snapshot(session.id).catch(() => undefined)
      if (paused) result[session.id] = toStatus({ status: "paused", ...paused })
    }
    return result
  }
}
