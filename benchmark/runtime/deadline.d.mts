export function executionDeadline(options: {
  marker: string
  startupSeconds: number
  agentSeconds: number
  pollMs?: number
  onTimeout: (stage: "startup" | "agent") => void
}): {
  state: {
    startup_started_at: number
    model_started_at: number | null
    timeout_stage: "startup" | "agent" | null
    marker_error: string | null
  }
  stop(): Promise<void>
}
