import type { BrowserAgentActivity } from "./protocol.js"

export function updateBrowserActivities(
  activities: readonly BrowserAgentActivity[],
  activity: BrowserAgentActivity,
): BrowserAgentActivity[] {
  const matches = (item: BrowserAgentActivity) =>
    item.sessionID === activity.sessionID && item.operationID === activity.operationID
  if (activity.kind === "idle" && !activities.some((item) => matches(item) && item.kind !== "idle"))
    return [...activities]
  const next = activities.filter(
    (item) =>
      !matches(item) &&
      !(
        activity.kind === "idle" &&
        activity.completed !== false &&
        item.sessionID === activity.sessionID &&
        item.kind === "idle"
      ),
  )
  if (activity.kind !== "idle" || activity.completed !== false) next.push(activity)
  while (next.length > 256) {
    const idle = next.findIndex((item) => item.kind === "idle")
    next.splice(idle === -1 ? 0 : idle, 1)
  }
  return next
}
