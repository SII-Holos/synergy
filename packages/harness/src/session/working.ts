import { Log } from "../util/log"
import { SessionManager } from "./manager"
import type { StatusInfo, WorkingInfo } from "./types"

const log = Log.create({ service: "session.working" })

/**
 * The runtime projection of a session's status.
 *
 * Two sources only, in priority order:
 *
 * 1. The live turn — `busy` or `retry`, owned by the runtime.
 * 2. The persisted pause latch — a session stopped mid-work that will stay
 *    stopped until the user acts.
 *
 * Anything else is idle. Notably absent is any inference from persisted
 * workflow state: a stored `active` loop is a record of intent, not evidence
 * that a turn is running, and projecting it as work is what let a dead process
 * pin a session in a state no control could clear.
 */
export async function resolve(sessionID: string): Promise<WorkingInfo | undefined> {
  if (SessionManager.isRunning(sessionID)) {
    const runtime = SessionManager.getRuntime(sessionID)
    const status = runtime?.status
    if (status?.type === "busy") return { status: "busy", description: status.description }
    if (status?.type === "retry")
      return { status: "retry", attempt: status.attempt, message: status.message, next: status.next }
  }

  const session = await SessionManager.getSession(sessionID)
  if (!session?.paused) return undefined
  log.info("resolved paused session", { sessionID, reason: session.paused.reason })
  return {
    status: "paused",
    reason: session.paused.reason,
    ...(session.paused.description ? { description: session.paused.description } : {}),
    since: session.paused.since,
  }
}

export function toStatus(working: WorkingInfo): StatusInfo {
  switch (working.status) {
    case "busy":
      return { type: "busy", description: working.description }
    case "retry":
      return { type: "retry", attempt: working.attempt, message: working.message, next: working.next }
    case "paused":
      return {
        type: "paused",
        reason: working.reason,
        ...(working.description ? { description: working.description } : {}),
        since: working.since,
      }
  }
}
