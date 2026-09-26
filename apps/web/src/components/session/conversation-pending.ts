import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk"

export type PendingTimelineItemView = {
  frozen: boolean
  primaryAction: "guide" | "queue" | undefined
  canWithdraw: boolean
}

export function selectPendingTimelineItems(
  items: readonly SessionInboxItem[] | undefined,
  messages: ReadonlyArray<{ id: string }>,
): SessionInboxItem[] {
  if (!items?.length) return []
  const materializedMessageIDs = new Set(messages.map((message) => message.id))
  return items
    .filter((item) => item.mode === "task" || item.mode === "steer")
    .filter((item) => item.message?.visible !== false)
    .filter((item) => (item.message?.origin?.type ?? item.source?.type) === "user")
    .filter((item) => !materializedMessageIDs.has(item.messageID))
}

export function pendingTimelineItemView(
  mode: SessionInboxItem["mode"],
  rollbackActive: boolean,
  options?: { hasCanonicalRoot?: boolean; status?: SessionInboxItem["status"] },
): PendingTimelineItemView {
  const firstTaskLocked = mode === "task" && options?.hasCanonicalRoot === false && options.status !== "failed"
  if (rollbackActive || firstTaskLocked || (mode !== "task" && mode !== "steer")) {
    return {
      frozen: rollbackActive || firstTaskLocked,
      primaryAction: undefined,
      canWithdraw: false,
    }
  }

  return {
    frozen: false,
    primaryAction: options?.status === "failed" ? undefined : mode === "steer" ? "queue" : "guide",
    canWithdraw: true,
  }
}
