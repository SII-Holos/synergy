import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk"

export type PendingTimelineItemView = {
  frozen: boolean
  primaryAction: "guide" | "queue" | undefined
  canWithdraw: boolean
}

export function pendingTimelineItemView(
  mode: SessionInboxItem["mode"],
  rollbackActive: boolean,
): PendingTimelineItemView {
  if (rollbackActive || (mode !== "task" && mode !== "steer")) {
    return {
      frozen: rollbackActive,
      primaryAction: undefined,
      canWithdraw: false,
    }
  }

  return {
    frozen: false,
    primaryAction: mode === "steer" ? "queue" : "guide",
    canWithdraw: true,
  }
}
