import { createRuntimeHealth } from "./health.js"
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

export interface RuntimeHealth {
  pluginId: string
  state: string
  mode: string
  startedAt?: number
  pid?: number
  memoryMb?: number
  restarts: number
  lastHeartbeatAt?: number
  lastError?: string
  runtimeDecision?: string
  warnings: RuntimeWarning[]
}

export interface PersistedRuntimeEntry {
  pluginId: string
  mode: string
  pid?: number
  state: RuntimeState
  restarts: number
  lastHeartbeatAt?: number
  startedAt?: number
  lastError?: string
}

// === RuntimeRegistry ===

export class RuntimeRegistry {
  private entries = new Map<string, RuntimeEntry>()

  get(pluginId: string): RuntimeEntry | undefined {
    return this.entries.get(pluginId)
  }

  has(pluginId: string): boolean {
    return this.entries.has(pluginId)
  }

  list(): RuntimeEntry[] {
    return Array.from(this.entries.values())
  }

  set(entry: RuntimeEntry): void {
    this.entries.set(entry.pluginId, entry)
  }

  update(pluginId: string, updater: (entry: RuntimeEntry) => void): RuntimeEntry | undefined {
    const entry = this.entries.get(pluginId)
    if (!entry) return undefined
    updater(entry)
    return entry
  }

  delete(pluginId: string): void {
    this.entries.delete(pluginId)
  }

  clear(): void {
    this.entries.clear()
  }

  pushWarning(pluginId: string, type: RuntimeWarningType, message: string, at?: number): void {
    const entry = this.entries.get(pluginId)
    if (!entry) return
    entry.warnings.push({ type, message, at: at ?? Date.now() })
  }

  getHealth(pluginId: string): RuntimeHealth | null {
    const entry = this.entries.get(pluginId)
    if (!entry) return null
    return createRuntimeHealth(entry)
  }

  snapshot(): PersistedRuntimeEntry[] {
    const result: PersistedRuntimeEntry[] = []
    for (const entry of this.entries.values()) {
      result.push({
        pluginId: entry.pluginId,
        mode: entry.mode,
        pid: entry.pid,
        state: entry.state,
        restarts: entry.restarts,
        lastHeartbeatAt: entry.lastHeartbeatAt,
        startedAt: entry.startedAt,
        lastError: entry.lastError,
      })
    }
    return result
  }

  restore(entries: PersistedRuntimeEntry[]): void {
    for (const persisted of entries) {
      const entry: RuntimeEntry = {
        pluginId: persisted.pluginId,
        mode: persisted.mode as RuntimeMode,
        pid: persisted.pid,
        state: persisted.state,
        restarts: persisted.restarts,
        lastHeartbeatAt: persisted.lastHeartbeatAt,
        startedAt: persisted.startedAt,
        lastError: persisted.lastError,
        warnings: [],
      }
      this.entries.set(persisted.pluginId, entry)
    }
  }
}

export const defaultRuntimeRegistry = new RuntimeRegistry()
