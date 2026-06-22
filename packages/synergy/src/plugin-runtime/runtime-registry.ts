import type { Worker } from "node:worker_threads"
import type { ConcurrencyLimiter, LogRateLimiter } from "./resource-limits.js"

// === Types ===

export type RuntimeMode = "in-process" | "worker" | "process"

export type RuntimeState = "starting" | "ready" | "unhealthy" | "stopped" | "crashed"

export type RuntimeWarningType =
  | "capability_denied"
  | "memory_limit_exceeded"
  | "log_rate_limited"
  | "heartbeat_missed"
  | "startup_timeout"
  | "worker_error"
  | "spawn_failed"
  | "signature_mismatch"

export interface RuntimeWarning {
  type: RuntimeWarningType
  message: string
  at: number
}

export interface RuntimeEntry {
  pluginId: string
  mode: RuntimeMode
  runtimeDecision?: string
  pid?: number
  state: RuntimeState
  restarts: number
  lastHeartbeatAt?: number
  memoryMb?: number
  startedAt?: number
  lastError?: string
  warnings: RuntimeWarning[]
  process?: Bun.Subprocess
  worker?: Worker
  concurrencyLimiter?: ConcurrencyLimiter
  memoryMonitor?: { stop: () => void }
  logRateLimiter?: LogRateLimiter
}

// === Registry ===

export const runtimeRegistry = new Map<string, RuntimeEntry>()

export function getRuntime(pluginId: string): RuntimeEntry | undefined {
  return runtimeRegistry.get(pluginId)
}

export function getAllRuntimes(): RuntimeEntry[] {
  return Array.from(runtimeRegistry.values())
}

// === Warning persistence ===

/**
 * Push a warning onto a plugin's RuntimeEntry warnings array.
 * Safe to call when the plugin is not registered (no-op).
 *
 * This is the canonical way to inject persistent warnings from supervisors,
 * resource monitors, and enforcement handlers.
 */
export function pushWarning(pluginId: string, type: RuntimeWarningType, message: string, at?: number): void {
  const entry = getRuntime(pluginId)
  if (!entry) return
  entry.warnings.push({ type, message, at: at ?? Date.now() })
}
