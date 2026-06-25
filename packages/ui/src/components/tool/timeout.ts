export interface ToolTimeoutMetadata {
  executionBudgetMs?: number
  operationTimeoutMs?: number
  displayMs?: number
  source?: string
}

export interface ToolTime {
  start?: number
  end?: number
}

export interface ToolCountdown {
  seconds: number
  startedAt?: number
}

export function toolCountdown(
  metadata: Record<string, any> | undefined,
  time: ToolTime | undefined,
): ToolCountdown | undefined {
  const timeout = metadata?.toolTimeout as ToolTimeoutMetadata | undefined
  const displayMs = timeout?.displayMs
  if (typeof displayMs !== "number" || !Number.isFinite(displayMs) || displayMs <= 0) return undefined
  return {
    seconds: Math.ceil(displayMs / 1000),
    startedAt: typeof time?.start === "number" ? time.start : undefined,
  }
}
