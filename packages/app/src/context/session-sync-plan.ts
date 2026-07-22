export type SessionSyncTrigger = { type: "workspace-transition" }

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

export async function refreshSessionAfterPending(
  pending: Promise<unknown>,
  refresh: () => Promise<unknown>,
): Promise<void> {
  await pending
  await refresh()
}

/**
 * Decide whether session metadata and/or durable message/part snapshots must be
 * re-fetched. Tool parts publish as unsequenced streaming events, so reconnect
 * recovery cannot rely on event replay alone (issue #509).
 */
export function planSessionSyncReload(input: SessionSyncPlanInput): SessionSyncPlan {
  const versionStale = input.lastSyncedReconnectVersion !== input.reconnectVersion
  const needsDerivedHistoryRefresh = input.canUnrollback
  const workspaceTransition = input.trigger?.type === "workspace-transition"
  const forceSession = !input.hasSessionRecord || versionStale || needsDerivedHistoryRefresh || workspaceTransition
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
