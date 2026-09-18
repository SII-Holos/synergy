import type { AgentWorkerCapacityStatus } from "@ericsanchezok/synergy-sdk/client"

export type AgentWorkerCapacityDisplay = {
  source: "explicit" | "derived"
  value: string
}

// The row must name what will actually run: the resolved ceiling and whether
// configuration or the machine decided it. `source` is the runtime's own
// answer to that question, so the display never re-derives it.
export function agentWorkerCapacityDisplay(
  status: AgentWorkerCapacityStatus | undefined,
): AgentWorkerCapacityDisplay | undefined {
  if (!status) return undefined
  return { source: status.source, value: String(status.effective) }
}
