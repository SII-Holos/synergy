import { Log } from "@/util/log"
import { SessionManager } from "./manager"
import type { Info, StatusInfo, WorkingInfo } from "./types"
import { MessageV2 } from "./message-v2"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Identifier } from "@/id/id"
import { Scope } from "@/scope"
import { SessionProgress } from "./progress"
import { BlueprintLoopStore } from "../blueprint/loop-store"
import { LatticeStore } from "../lattice/store"

const log = Log.create({ service: "session.working" })

const ACTIVE_BLUEPRINT_LOOP_STATUSES = new Set(["armed", "running", "waiting", "auditing"])

export async function resolve(sessionID: string): Promise<WorkingInfo | undefined> {
  const runtime = SessionManager.getRuntime(sessionID)
  if (runtime?.abort) {
    const s = runtime.status
    if (s.type === "busy") return { status: "busy", description: s.description }
    if (s.type === "retry") return { status: "retry", attempt: s.attempt, message: s.message, next: s.next }
  }
  const session = await SessionManager.getSession(sessionID)
  if (!session) return undefined
  const scopeID = Identifier.asScopeID((session.scope as Scope).id)
  const sid = Identifier.asSessionID(sessionID)

  if (await hasActiveWorkflow({ session, scopeID })) {
    log.info("detected recovering session (workflow)", { sessionID, workflow: session.workflow?.kind })
    return { status: "recovering" }
  }

  if (await hasActiveBlueprintLoop({ session, scopeID })) {
    log.info("detected recovering session (blueprint loop)", { sessionID, loopID: session.blueprint?.loopID })
    return { status: "recovering" }
  }

  const messageIDs = await Storage.scan(StoragePath.sessionMessagesRoot(scopeID, sid)).catch(() => [] as string[])
  for (const mid of messageIDs.sort().reverse()) {
    const info = await Storage.read<MessageV2.Info>(
      StoragePath.messageInfo(scopeID, sid, mid as Identifier.MessageID),
    ).catch(() => undefined)
    if (!info || info.role !== "assistant") continue
    if (info.time.completed == null) {
      log.info("detected recovering session (incomplete)", { sessionID, messageID: info.id })
      return { status: "recovering" }
    }
    break
  }

  if (session.pendingReply && (await pendingReplyFor(scopeID, sessionID))) {
    log.info("detected recovering session (pending reply)", { sessionID })
    return { status: "recovering" }
  }

  return undefined
}

async function hasActiveWorkflow(input: { session: Info; scopeID: Identifier.ScopeID }): Promise<boolean> {
  const workflow = input.session.workflow
  if (!workflow) return false
  if (workflow.kind === "lightloop") return true
  if (workflow.kind !== "lattice") return false
  const run = await LatticeStore.getOrUndefined(input.scopeID, input.session.id).catch(() => undefined)
  return run?.status === "active" || run?.status === "paused"
}

async function hasActiveBlueprintLoop(input: { session: Info; scopeID: Identifier.ScopeID }): Promise<boolean> {
  const loopID = input.session.blueprint?.loopID
  if (!loopID) return false
  const loop = await BlueprintLoopStore.get(input.scopeID, loopID).catch(() => undefined)
  return !!loop && ACTIVE_BLUEPRINT_LOOP_STATUSES.has(loop.status)
}

async function pendingReplyFor(scopeID: string, sessionID: string): Promise<boolean> {
  const messages = await MessageV2.filterCompacted(MessageV2.stream({ scopeID, sessionID })).catch(() => [])
  messages.sort((a, b) => a.info.id.localeCompare(b.info.id))
  return SessionProgress.pendingReply(messages)
}

export function toStatus(working: WorkingInfo): StatusInfo {
  switch (working.status) {
    case "busy":
      return { type: "busy", description: working.description }
    case "retry":
      return { type: "retry", attempt: working.attempt, message: working.message, next: working.next }
    case "recovering":
      return { type: "recovering" }
  }
}
