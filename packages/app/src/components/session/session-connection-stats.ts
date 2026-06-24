import type { CortexTask, LspStatus, McpStatus } from "@ericsanchezok/synergy-sdk/client"

export interface LspStats {
  connected: number
  hasError: boolean
  total: number
}

export function computeLspStats(lsp: LspStatus[] | undefined): LspStats {
  const items = lsp ?? []
  const connected = items.filter((s) => s.status === "connected").length
  const hasError = items.some((s) => s.status === "error")
  return { connected, hasError, total: items.length }
}

export interface McpStats {
  enabled: number
  failed: boolean
  total: number
}

export function computeMcpStats(mcp: Record<string, McpStatus> | undefined): McpStats {
  const entries = Object.entries(mcp ?? {})
  const enabled = entries.filter(([, status]) => status.status === "connected").length
  const failed = entries.some(([, status]) => status.status === "failed")
  return { enabled, failed, total: entries.length }
}

export interface CortexStats {
  active: number
  completed: number
  hasRunning: boolean
}

export function computeCortexStats(tasks: CortexTask[] | undefined, sessionID: string): CortexStats {
  const items = (tasks ?? []).filter((t) => t.parentSessionID === sessionID)
  const running = items.filter((t) => t.status === "running").length
  const queued = items.filter((t) => t.status === "queued").length
  const completed = items.filter((t) => t.status === "completed" || t.status === "error").length
  return { active: running + queued, completed, hasRunning: running > 0 }
}
