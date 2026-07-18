import type { SessionInboxItem } from "@ericsanchezok/synergy-sdk/client"
import { S } from "./session-i18n"

export type PendingTimelineAction = {
  kind: "guide" | "queue" | "withdraw"
  label: (typeof S)[keyof typeof S]
  title: (typeof S)[keyof typeof S]
}

export function pendingTimelineActions(mode: SessionInboxItem["mode"]): PendingTimelineAction[] {
  if (mode === "context") return []

  const primary: PendingTimelineAction =
    mode === "steer"
      ? { kind: "queue", label: S.convQueue, title: S.convMoveToQueueTitle }
      : { kind: "guide", label: S.convGuide, title: S.convGuideRunTitle }

  return [primary, { kind: "withdraw", label: S.convWithdraw, title: S.convRemovePendingTitle }]
}
