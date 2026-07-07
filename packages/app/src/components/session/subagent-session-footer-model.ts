import type { SessionStatus } from "@ericsanchezok/synergy-sdk/client"

export function subagentFooterSessionStatus(
  sessionStatusByID: Record<string, SessionStatus | undefined>,
  sessionID: string,
): SessionStatus | undefined {
  return sessionStatusByID[sessionID]
}
