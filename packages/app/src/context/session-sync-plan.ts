export type SessionSyncTrigger = { type: "workspace-transition" | "history-transition" }

export type SessionSyncPlanInput = {
  hasSessionRecord: boolean
  hasMessages: boolean
  reconnectVersion: number
  lastSyncedReconnectVersion: number | undefined
  canUnrollback: boolean
  trigger?: SessionSyncTrigger
}

export type SessionSyncPlan = {
  versionStale: boolean
  needsDerivedHistoryRefresh: boolean
  forceSession: boolean
  forceMessages: boolean
  ready: boolean
}

export function sessionSyncWatchKey(input: {
  sessionID: string | undefined
  connected: boolean
  reconnectVersion: number
}) {
  return [input.sessionID, input.connected, input.reconnectVersion] as const
}

export async function refreshSessionAfterPending(
  pending: Promise<unknown>,
  refresh: () => Promise<unknown>,
): Promise<void> {
  await pending.catch(() => undefined)
  await refresh()
}

export function trackSessionSync(
  inflight: Map<string, Promise<void>>,
  sessionID: string,
  request: Promise<unknown>,
): Promise<void> {
  const tracked = request
    .then(() => undefined)
    .finally(() => {
      if (inflight.get(sessionID) === tracked) inflight.delete(sessionID)
    })
  inflight.set(sessionID, tracked)
  return tracked
}

/**
 * Decide whether session metadata and/or durable message/part snapshots must be
 * re-fetched. Explicit transition triggers always refresh authoritative session
 * metadata. Tool parts publish as unsequenced streaming events, so reconnect
 * recovery cannot rely on event replay alone (issue #509).
 */
export function planSessionSyncReload(input: SessionSyncPlanInput): SessionSyncPlan {
  const versionStale = input.lastSyncedReconnectVersion !== input.reconnectVersion
  const needsDerivedHistoryRefresh = input.canUnrollback
  const sessionTransition = input.trigger !== undefined
  const forceSession = !input.hasSessionRecord || versionStale || needsDerivedHistoryRefresh || sessionTransition
  const forceMessages = !input.hasMessages || versionStale || needsDerivedHistoryRefresh
  const ready = !forceSession && !forceMessages
  return {
    versionStale,
    needsDerivedHistoryRefresh,
    forceSession,
    forceMessages,
    ready,
  }
}

export type ToolPartApplyAction = "create-bucket" | "insert" | "reconcile"

export function describeToolPartApply(input: { hasBucket: boolean; found: boolean }): ToolPartApplyAction {
  if (!input.hasBucket) return "create-bucket"
  return input.found ? "reconcile" : "insert"
}
