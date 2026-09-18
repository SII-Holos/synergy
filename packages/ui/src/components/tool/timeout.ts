import type { ToolTimeoutMetadata } from "@ericsanchezok/synergy-util/tool-timeout"

export type CountdownKind = "auto_background" | "timeout" | "remaining"

export interface ToolTime {
  start?: number
  end?: number
}

export interface ToolCountdown {
  seconds: number
  startedAt: number
  kind: CountdownKind
}

export function toolCountdown(
  metadata: Record<string, any> | undefined,
  time: ToolTime | undefined,
): ToolCountdown | undefined {
  const timeout = metadata?.toolTimeout as ToolTimeoutMetadata | undefined
  const displayMs = timeout?.displayMs
  if (typeof displayMs !== "number" || !Number.isFinite(displayMs) || displayMs <= 0) return undefined
  const startedAt = time?.start
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return undefined
  return {
    seconds: Math.ceil(displayMs / 1000),
    startedAt,
    kind: countdownKind(timeout?.source),
  }
}

function countdownKind(source: string | undefined): CountdownKind {
  if (source === "auto_background") return "auto_background"
  if (source === "tool_timeout") return "timeout"
  return "remaining"
}
