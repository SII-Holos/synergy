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

export type SessionSyncWatchKey = readonly [
  sessionID: string | undefined,
  connected: boolean,
  ready: boolean,
  reconnectVersion: number,
]

export function sessionSyncWatchKey(input: {
  sessionID: string | undefined
  connected: boolean
  ready: boolean
  reconnectVersion: number
}): SessionSyncWatchKey {
  return [input.sessionID, input.connected, input.ready, input.reconnectVersion]
}

export function shouldRunSessionSync(current: SessionSyncWatchKey, previous?: SessionSyncWatchKey) {
  const [sessionID, connected, ready, reconnectVersion] = current
  if (!sessionID || !connected || !ready) return false
  if (!previous || previous[0] !== sessionID) return true
  const reconnected = previous[1] === false && connected
  const recoveryCompleted = previous[3] !== reconnectVersion
  return !reconnected || recoveryCompleted
}

export async function refreshSessionAfterPending(
  pending: Promise<unknown>,
  refresh: () => Promise<unknown>,
): Promise<void> {
  await pending.catch(() => undefined)
  await refresh()
}
export type SessionSyncTarget = {
  reconnectVersion: number
  forceSession: boolean
  forceMessages: boolean
}

export type TrackedSessionSync = {
  target: SessionSyncTarget
  request: Promise<void>
}

export function sessionSyncTargetSatisfiedBy(active: SessionSyncTarget, requested: SessionSyncTarget) {
  return (
    active.reconnectVersion >= requested.reconnectVersion &&
    (!requested.forceSession || active.forceSession) &&
    (!requested.forceMessages || active.forceMessages)
  )
}

export function trackSessionSync(
  inflight: Map<string, TrackedSessionSync>,
  sessionID: string,
  target: SessionSyncTarget,
  request: Promise<unknown>,
): Promise<void> {
  const tracked = request
    .then(() => undefined)
    .finally(() => {
      if (inflight.get(sessionID)?.request === tracked) inflight.delete(sessionID)
    })
  inflight.set(sessionID, { target, request: tracked })
  return tracked
}

export function queueSessionSync(
  inflight: Map<string, TrackedSessionSync>,
  sessionID: string,
  target: SessionSyncTarget,
  run: () => Promise<unknown>,
): Promise<void> {
  const active = inflight.get(sessionID)
  if (active && sessionSyncTargetSatisfiedBy(active.target, target)) return active.request
  const request = active ? refreshSessionAfterPending(active.request, run) : run()
  return trackSessionSync(inflight, sessionID, target, request)
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
