import type { RuntimeEntry, RuntimeHealth } from "./registry.js"
import {
  DEFAULT_PLUGIN_RUNTIME_LIMITS,
  resolveRuntimeLimits,
  type RuntimeLimitOverrides,
  type RuntimeLimits,
} from "@ericsanchezok/synergy-plugin/policy"

export type { RuntimeHealth }
export type { RuntimeLimitOverrides, RuntimeLimits }

// === Runtime limits ===

export const DEFAULT_LIMITS: RuntimeLimits = DEFAULT_PLUGIN_RUNTIME_LIMITS
export { resolveRuntimeLimits }

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
