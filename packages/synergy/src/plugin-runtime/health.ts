import type { RuntimeEntry, RuntimeHealth } from "./registry.js"

export type { RuntimeHealth }

// === Constants ===

export const DEFAULT_LIMITS = {
  STARTUP_TIMEOUT_MS: 5000,
  REQUEST_TIMEOUT_MS: 30000,
  SHUTDOWN_GRACE_MS: 1500,
  CONCURRENT_REQUESTS: 8,
  MAX_LOG_BYTES_PER_MINUTE: 128_000,
  MEMORY_MB: 256,
  HEARTBEAT_INTERVAL_MS: 5000,
  HEARTBEAT_MISSES_BEFORE_KILL: 3,
} as const

// === Pure health snapshot ===

/**
 * Create a health snapshot from a RuntimeEntry.
 *
 * Pure helper — no global state dependency. The returned `warnings` array
 * is the same mutable reference held by the `RuntimeEntry`, so callers
 * (and persistent warning CRUD) can append to it and changes will be
 * visible in subsequent health snapshots.
 */
export function createRuntimeHealth(entry: RuntimeEntry): RuntimeHealth {
  return {
    pluginId: entry.pluginId,
    state: entry.state,
    mode: entry.mode,
    startedAt: entry.startedAt,
    pid: entry.pid,
    memoryMb: entry.memoryMb,
    restarts: entry.restarts,
    lastHeartbeatAt: entry.lastHeartbeatAt,
    lastError: entry.lastError,
    runtimeDecision: entry.runtimeDecision,
    warnings: entry.warnings,
  }
}
