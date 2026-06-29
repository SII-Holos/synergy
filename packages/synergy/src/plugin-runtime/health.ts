import type { RuntimeEntry, RuntimeHealth } from "./registry.js"

export type { RuntimeHealth }

// === Runtime limits ===

export interface RuntimeLimits {
  startupTimeoutMs: number
  requestTimeoutMs: number
  shutdownGraceMs: number
  maxConcurrentRequests: number
  maxLogBytesPerMinute: number
  memoryMb: number
  memoryPollIntervalMs: number
  heartbeatIntervalMs: number
  heartbeatMissesBeforeKill: number
}

export type RuntimeLimitOverrides = Partial<RuntimeLimits>

export const DEFAULT_LIMITS: RuntimeLimits = {
  startupTimeoutMs: 5_000,
  requestTimeoutMs: 30_000,
  shutdownGraceMs: 1_500,
  maxConcurrentRequests: 8,
  maxLogBytesPerMinute: 128_000,
  memoryMb: 256,
  memoryPollIntervalMs: 10_000,
  heartbeatIntervalMs: 5_000,
  heartbeatMissesBeforeKill: 3,
}

export function resolveRuntimeLimits(...overrides: Array<RuntimeLimitOverrides | undefined>): RuntimeLimits {
  const resolved = { ...DEFAULT_LIMITS }
  for (const override of overrides) {
    if (!override) continue
    for (const [key, value] of Object.entries(override) as Array<[keyof RuntimeLimits, unknown]>) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue
      resolved[key] = Math.round(value)
    }
  }
  return resolved
}

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
