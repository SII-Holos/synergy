import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"
import { Identifier } from "@/id/id"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { SessionEndpoint } from "./endpoint"
import { SessionNav, type ScopeNavIndex } from "./nav"
import type { Info, StatusInfo } from "./types"
import { SessionProgress } from "./progress"
import { Session } from "./index"
import { MessageV2 } from "./message-v2"
import { BlueprintLoopStore, isActiveLoopStatus } from "../blueprint/loop-store"
import type { Info as BlueprintLoopInfo } from "../blueprint/types"
import { NoteStore } from "../note"
import { ScopeContext } from "../scope/context"

export namespace SessionRecovery {
  export interface Location {
    sessionID: string
    scopeID: string
    directory?: string
    endpointKey?: string
  }

  export interface Health {
    sessionID: string
    scopeID: string
    infoReadable: boolean
    totalBytes: number
    messageCount: number
    partCount: number
    corruptJsonCount: number
    largestJsonBytes: number
  }

  export interface DeleteReport {
    sessionIDs: string[]
    removed: string[]
    missing: string[]
    errors: Array<{ target: string; message: string }>
  }

  export interface RepairReport {
    scanned: number
    repaired: number
    entries: Array<{ sessionID: string; scopeID: string; action: string }>
  }

  export interface RuntimeReconcileReport {
    scopes: string[]
    sessionsScanned: number
    loopsScanned: number
    changed: number
    entries: Array<{ scopeID: string; sessionID?: string; noteID?: string; loopID?: string; action: string }>
  }

  const TERMINAL_LOOP_STATUSES = new Set<BlueprintLoopInfo["status"]>(["completed", "failed", "cancelled"])

  function isActiveLoop(loop: BlueprintLoopInfo | undefined) {
    return !!loop && isActiveLoopStatus(loop.status)
  }

  function isTerminalLoop(loop: BlueprintLoopInfo | undefined) {
    return !!loop && TERMINAL_LOOP_STATUSES.has(loop.status)
  }

  function isWorkflowRecoveryCandidate(session: Info) {
    return session.workflow?.kind === "lightloop" || session.workflow?.kind === "lattice"
  }

  function isSessionRecoveryCandidate(session: Info) {
    if (session.time.archived) return false
    return session.pendingReply === true || !!session.blueprint?.loopID || isWorkflowRecoveryCandidate(session)
  }

  async function scopeIDsForRuntimeRecovery(scopeID?: string): Promise<string[]> {
    if (scopeID) return [scopeID]
    const ids = new Set<string>()
    for (const id of await Storage.scan(["sessions"]).catch(() => [])) ids.add(id)
    for (const id of await Storage.scan(["blueprint_loops"]).catch(() => [])) ids.add(id)
    return [...ids].sort()
  }

  async function sessionInfos(scopeID: string): Promise<Info[]> {
    const sid = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.sessionsRoot(sid)).catch(() => [])
    if (ids.length === 0) return []
    const keys = ids.map((id) => StoragePath.sessionInfo(sid, Identifier.asSessionID(id)))
    const results = await Storage.readMany<Info>(keys)
    return results.filter((item): item is Info => !!item && !!item.scope)
  }

  function reportChange(
    report: RuntimeReconcileReport,
    input: { scopeID: string; sessionID?: string; noteID?: string; loopID?: string; action: string },
  ) {
    report.changed++
    report.entries.push(input)
  }

  async function reconcilePendingReply(input: {
    scopeID: string
    session: Info
    apply: boolean
    report: RuntimeReconcileReport
  }) {
    if (!input.session.pendingReply) return
    const pendingReply = await SessionProgress.pendingReplyFor({
      scopeID: input.scopeID,
      sessionID: input.session.id,
    }).catch(() => true)
    if (pendingReply) return

    if (input.apply) {
      await Session.update(input.session.id, (draft) => {
        draft.pendingReply = undefined
      })
    }
    reportChange(input.report, {
      scopeID: input.scopeID,
      sessionID: input.session.id,
      action: "pending_reply_cleared",
    })
  }

  async function reconcileNoteActiveLoop(input: {
    scopeID: string
    loop: BlueprintLoopInfo
    apply: boolean
    report: RuntimeReconcileReport
  }) {
    const note = await NoteStore.getAny(input.scopeID, input.loop.noteID).catch(() => undefined)
    if (!note || note.kind !== "blueprint") return
    if (note.blueprint?.activeLoopID === input.loop.id) return

    if (input.apply) {
      await NoteStore.updateAny(input.scopeID, input.loop.noteID, {
        blueprint: { activeLoopID: input.loop.id },
      })
    }
    reportChange(input.report, {
      scopeID: input.scopeID,
      loopID: input.loop.id,
      action: "note_active_loop_restored",
    })
  }

  async function clearNoteActiveLoop(input: {
    scopeID: string
    loop: BlueprintLoopInfo
    apply: boolean
    report: RuntimeReconcileReport
  }) {
    const note = await NoteStore.getAny(input.scopeID, input.loop.noteID).catch(() => undefined)
    if (!note || note.kind !== "blueprint" || note.blueprint?.activeLoopID !== input.loop.id) return

    if (input.apply) {
      await NoteStore.updateAny(input.scopeID, input.loop.noteID, {
        blueprint: { activeLoopID: null },
      })
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
    report: RuntimeReconcileReport
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
    report: RuntimeReconcileReport
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
    loops: Map<string, BlueprintLoopInfo>
    apply: boolean
    report: RuntimeReconcileReport
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
    loops: Map<string, BlueprintLoopInfo>
    apply: boolean
    report: RuntimeReconcileReport
  }) {
    const notes = await NoteStore.list(input.scopeID, "all").catch(() => [])
    for (const note of notes) {
      if (note.kind !== "blueprint") continue
      const loopID = note.blueprint?.activeLoopID
      if (!loopID) continue
      const loop = input.loops.get(loopID)
      if (isActiveLoop(loop)) continue

      if (input.apply) {
        await NoteStore.updateAny(input.scopeID, note.id, {
          blueprint: { activeLoopID: null },
        })
      }
      reportChange(input.report, {
        scopeID: input.scopeID,
        noteID: note.id,
        loopID,
        action: loop ? "note_inactive_loop_cleared" : "note_missing_loop_cleared",
      })
    }
  }

  async function reconcileRuntimeScope(input: { scopeID: string; apply: boolean; report: RuntimeReconcileReport }) {
    const [sessions, loops] = await Promise.all([
      sessionInfos(input.scopeID),
      BlueprintLoopStore.list(input.scopeID).catch(() => [] as BlueprintLoopInfo[]),
    ])
    input.report.sessionsScanned += sessions.length
    input.report.loopsScanned += loops.length

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
      await reconcilePendingReply({ ...input, session })
      await reconcileSessionBlueprintReference({ ...input, session, loops: loopsByID })
    }
    await reconcileNoteBlueprintReferences({ ...input, loops: loopsByID })
  }

  export async function reconcileRuntimeState(
    input: {
      scopeID?: string
      apply?: boolean
    } = {},
  ): Promise<RuntimeReconcileReport> {
    const report: RuntimeReconcileReport = {
      scopes: await scopeIDsForRuntimeRecovery(input.scopeID),
      sessionsScanned: 0,
      loopsScanned: 0,
      changed: 0,
      entries: [],
    }
    for (const scopeID of report.scopes) {
      await reconcileRuntimeScope({ scopeID, apply: input.apply === true, report }).catch((error) => {
        report.entries.push({ scopeID, action: `scope_reconcile_failed:${String(error)}` })
      })
    }
    return report
  }

  export async function resumePendingStopRequests(targetScopeID?: string): Promise<number> {
    let requested = 0
    for (const scopeID of await scopeIDsForRuntimeRecovery(targetScopeID)) {
      const [sessions, loops] = await Promise.all([
        sessionInfos(scopeID),
        BlueprintLoopStore.list(scopeID).catch(() => [] as BlueprintLoopInfo[]),
      ])
      const sessionsByID = new Map(sessions.map((session) => [session.id, session]))
      const pending = new Map<string, Info>()

      for (const session of sessions) {
        if (!session.time || session.time.archived || session.workflow?.kind !== "lightloop") continue
        const stopRequest = session.workflow.stopRequest
        if (!stopRequest) continue
        if (stopRequest.reviewSessionID) {
          const reviewer = sessionsByID.get(stopRequest.reviewSessionID)
          if (reviewer?.cortex?.status !== "interrupted") continue
          await Session.update(session.id, (draft) => {
            if (draft.workflow?.kind !== "lightloop") return
            const current = draft.workflow.stopRequest
            if (!current || current.reviewSessionID !== stopRequest.reviewSessionID) return
            current.reviewTaskID = undefined
            current.reviewSessionID = undefined
          })
        }
        pending.set(session.id, session)
      }

      for (const loop of loops) {
        if (!loop.stopRequest) continue
        if (loop.status === "auditing" && loop.auditSessionID) {
          const reviewer = sessionsByID.get(loop.auditSessionID)
          if (reviewer?.cortex?.status !== "interrupted") continue
          await BlueprintLoopStore.updateStatus(scopeID, loop.id, {
            status: "running",
            auditSessionID: null,
            auditTaskID: null,
            stopRequest: loop.stopRequest,
          })
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
            const { SessionDrive } = await import("./drive")
            await SessionDrive.request(session.id, "stop-review-recovery")
          },
        })
        requested++
      }
    }
    return requested
  }

  export async function recoverableStatuses(scopeID: string): Promise<Record<string, StatusInfo>> {
    const { resolve, toStatus } = await import("./working")
    const [sessions, loops] = await Promise.all([
      sessionInfos(scopeID),
      BlueprintLoopStore.list(scopeID).catch(() => [] as BlueprintLoopInfo[]),
    ])
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
        result[session.id] = { type: "recovering", description: "BlueprintLoop interrupted" }
      }
    }
    return result
  }

  export async function resolve(input: { sessionID: string; scopeID?: string }): Promise<Location> {
    const sid = Identifier.asSessionID(input.sessionID)
    const index = await Storage.read<any>(StoragePath.sessionIndex(sid)).catch(() => undefined)
    const scopeID = input.scopeID ?? index?.scopeID
    if (!scopeID) throw new Error(`Scope is required for session ${input.sessionID}; pass --scope.`)
    return {
      sessionID: input.sessionID,
      scopeID,
      directory: index?.directory,
      endpointKey: index?.endpointKey,
    }
  }

  export async function health(input: { sessionID: string; scopeID: string }): Promise<Health> {
    const scope = Identifier.asScopeID(input.scopeID)
    const sid = Identifier.asSessionID(input.sessionID)
    const root = sessionRootPath(input.scopeID, input.sessionID)
    const [infoReadable, stats] = await Promise.all([
      Storage.read<Info>(StoragePath.sessionInfo(scope, sid))
        .then(() => true)
        .catch(() => false),
      scanJsonTree(root),
    ])
    const messageIDs = await Storage.scan(StoragePath.sessionMessagesRoot(scope, sid)).catch(() => [])
    let partCount = 0
    for (const messageID of messageIDs) {
      partCount += (
        await Storage.scan(StoragePath.messageParts(scope, sid, Identifier.asMessageID(messageID))).catch(() => [])
      ).length
    }
    return {
      sessionID: input.sessionID,
      scopeID: input.scopeID,
      infoReadable,
      totalBytes: stats.totalBytes,
      messageCount: messageIDs.length,
      partCount,
      corruptJsonCount: stats.corruptJsonCount,
      largestJsonBytes: stats.largestJsonBytes,
    }
  }

  export async function listHealth(scopeID: string): Promise<Health[]> {
    const scope = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.sessionsRoot(scope)).catch(() => [])
    const result: Health[] = []
    for (const sessionID of ids) result.push(await health({ scopeID, sessionID }))
    return result.sort((a, b) => b.totalBytes - a.totalBytes)
  }

  export async function inspect(input: { sessionID: string; scopeID?: string }): Promise<Health> {
    const location = await resolve(input)
    return health(location)
  }

  export async function remove(input: { sessionID: string; scopeID?: string }): Promise<DeleteReport> {
    const location = await resolve(input)
    const sessionIDs = await collectSessionTree(location.scopeID, location.sessionID)
    const report: DeleteReport = { sessionIDs, removed: [], missing: [], errors: [] }
    for (const sessionID of sessionIDs) {
      await removeOne({ ...location, sessionID }, report)
    }
    await cleanupIndexes(location.scopeID, new Set(sessionIDs), location.endpointKey, report)
    return report
  }

  export async function repair(input: { apply: boolean }): Promise<RepairReport> {
    const report: RepairReport = { scanned: 0, repaired: 0, entries: [] }
    const scopeIDs = await Storage.scan(["sessions"])
    for (const scopeID of scopeIDs) {
      const sessions = await listHealth(scopeID)
      report.scanned += sessions.length
      const broken = sessions.filter((entry) => !entry.infoReadable || entry.corruptJsonCount > 0)
      if (broken.length === 0) continue
      const ids = new Set(broken.map((entry) => entry.sessionID))
      for (const entry of broken) {
        report.entries.push({
          sessionID: entry.sessionID,
          scopeID,
          action: entry.infoReadable ? "corrupt-json" : "remove-from-indexes",
        })
      }
      if (input.apply) {
        const deleteReport: DeleteReport = { sessionIDs: [], removed: [], missing: [], errors: [] }
        await cleanupIndexes(scopeID, ids, undefined, deleteReport)
        report.repaired += ids.size
      }
    }
    return report
  }

  async function removeOne(location: Location, report: DeleteReport) {
    const scope = Identifier.asScopeID(location.scopeID)
    const sid = Identifier.asSessionID(location.sessionID)
    await removeTarget(
      `message-order-index:${location.sessionID}`,
      () => MessageV2.removeOrderIndex(scope, sid),
      report,
    )
    await removeTarget(
      `session:${location.sessionID}`,
      () => Storage.removeTree(StoragePath.sessionRoot(scope, sid)),
      report,
    )
    await removeTarget(
      `session-index:${location.sessionID}`,
      () => Storage.remove(StoragePath.sessionIndex(sid)),
      report,
    )
    await removeTarget(
      `snapshot:${location.sessionID}`,
      () =>
        fs.rm(path.join(Global.Path.snapshot, location.scopeID, location.sessionID), { recursive: true, force: true }),
      report,
    )
  }

  async function cleanupIndexes(
    scopeID: string,
    sessionIDs: Set<string>,
    endpointKey: string | undefined,
    report: DeleteReport,
  ) {
    const scope = Identifier.asScopeID(scopeID)
    const page = await Storage.read<any>(StoragePath.sessionsPageIndex(scope)).catch(() => undefined)
    if (page?.entries) {
      page.entries = page.entries.filter((entry: any) => !sessionIDs.has(entry.id))
      await removeTarget(
        `page-index:${scopeID}`,
        () => Storage.write(StoragePath.sessionsPageIndex(scope), page),
        report,
      )
    }

    const nav = await Storage.read<ScopeNavIndex>(StoragePath.sessionNavIndex(scope)).catch(() => undefined)
    if (nav?.entries) {
      nav.entries = nav.entries.filter((entry) => !sessionIDs.has(entry.id))
      nav.updatedAt = Date.now()
      await removeTarget(`nav-index:${scopeID}`, () => Storage.write(StoragePath.sessionNavIndex(scope), nav), report)
    }

    for (const sessionID of sessionIDs) {
      const sid = Identifier.asSessionID(sessionID)
      const info = await Storage.read<Info>(StoragePath.sessionInfo(scope, sid)).catch(() => undefined)
      const key = endpointKey ?? (info?.endpoint ? SessionEndpoint.toKey(info.endpoint) : undefined)
      if (key) {
        await removeTarget(
          `endpoint-index:${sessionID}`,
          () => Storage.remove(StoragePath.endpointSession(key, sid)),
          report,
        )
      }
      await removeTarget(`session-index:${sessionID}`, () => Storage.remove(StoragePath.sessionIndex(sid)), report)
      await SessionNav.removeNavEntry(scopeID, sessionID).catch(() => undefined)
    }
  }

  async function collectSessionTree(scopeID: string, rootSessionID: string): Promise<string[]> {
    const scope = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.sessionsRoot(scope)).catch(() => [])
    const children = new Map<string, string[]>()
    for (const id of ids) {
      const info = await Storage.read<Info>(StoragePath.sessionInfo(scope, Identifier.asSessionID(id))).catch(
        () => undefined,
      )
      if (!info?.parentID) continue
      const bucket = children.get(info.parentID) ?? []
      bucket.push(id)
      children.set(info.parentID, bucket)
    }
    const result: string[] = []
    const queue = [rootSessionID]
    while (queue.length) {
      const current = queue.shift()!
      result.push(current)
      queue.push(...(children.get(current) ?? []))
    }
    return result
  }

  async function removeTarget(label: string, action: () => Promise<unknown>, report: DeleteReport) {
    try {
      await action()
      report.removed.push(label)
    } catch (error) {
      report.errors.push({ target: label, message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function scanJsonTree(root: string) {
    let totalBytes = 0
    let corruptJsonCount = 0
    let largestJsonBytes = 0
    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue
        const stat = await fs.stat(full).catch(() => undefined)
        if (!stat) continue
        totalBytes += stat.size
        largestJsonBytes = Math.max(largestJsonBytes, stat.size)
        try {
          JSON.parse(await Bun.file(full).text())
        } catch {
          corruptJsonCount++
        }
      }
    }
    await walk(root)
    return { totalBytes, corruptJsonCount, largestJsonBytes }
  }

  function sessionRootPath(scopeID: string, sessionID: string) {
    return path.join(
      Global.Path.data,
      ...StoragePath.sessionRoot(Identifier.asScopeID(scopeID), Identifier.asSessionID(sessionID)),
    )
  }
}
