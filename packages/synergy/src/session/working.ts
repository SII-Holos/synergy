import { Log } from "@/util/log"
import { SessionManager } from "./manager"
import type { StatusInfo, WorkingInfo } from "./types"
import { MessageV2 } from "./message-v2"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Identifier } from "@/id/id"
import { Scope } from "@/scope"

const log = Log.create({ service: "session.working" })

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
  const messageIDs = await Storage.scan(StoragePath.sessionMessagesRoot(scopeID, sid)).catch(() => [] as string[])
  for (let i = messageIDs.length - 1; i >= 0; i--) {
    const mid = messageIDs[i]
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
  return undefined
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
