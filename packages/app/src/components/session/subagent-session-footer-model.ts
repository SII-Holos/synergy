import type { SessionStatus } from "@ericsanchezok/synergy-sdk/client"

export const SUBAGENT_FOOTER_MODEL_LABEL_CLASS = "min-w-0 flex-1 truncate text-11-regular text-text-subtle"

export function subagentFooterSessionStatus(
  sessionStatusByID: Record<string, SessionStatus | undefined>,
  sessionID: string,
): SessionStatus | undefined {
  return sessionStatusByID[sessionID]
}
