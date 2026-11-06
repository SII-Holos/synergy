import type { CurrentTurnChanges, Message, SessionHistoryInfo } from "@ericsanchezok/synergy-sdk/client"

export function reduceCurrentTurnChanges(
  current: CurrentTurnChanges | undefined,
  message: Message,
  history?: SessionHistoryInfo,
): CurrentTurnChanges | undefined {
  if (message.role !== "user" || !message.isRoot || message.visible === false) return current
  if (history?.rollback && message.id !== current?.rootID && message.time.created <= history.rollback.created)
    return current
  if (
    current &&
    (current.createdAt > message.time.created ||
      (current.createdAt === message.time.created && current.rootID > message.id))
  )
    return current
  return {
    rootID: message.id,
    createdAt: message.time.created,
    summary: message.summary ? { ...message.summary, diffs: [] } : undefined,
  }
}
