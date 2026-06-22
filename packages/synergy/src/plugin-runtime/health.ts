import { getRuntime } from "./supervisor.js"

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

// === Heartbeat monitor ===

export function startHeartbeatMonitor(
  pluginId: string,
  onMissedHeartbeat: (pluginId: string, missCount: number) => void,
): { stop: () => void } {
  let missCount = 0

  const interval = setInterval(() => {
    const entry = getRuntime(pluginId)
    if (!entry) {
      // Plugin may have been stopped/removed — stop monitoring
      clearInterval(interval)
      return
    }

    const now = Date.now()
    const lastHeartbeatAt = entry.lastHeartbeatAt ?? 0

    if (now - lastHeartbeatAt > DEFAULT_LIMITS.HEARTBEAT_INTERVAL_MS) {
      missCount++
      if (missCount >= DEFAULT_LIMITS.HEARTBEAT_MISSES_BEFORE_KILL) {
        clearInterval(interval)
        onMissedHeartbeat(pluginId, missCount)
      }
    } else {
      missCount = 0
    }
  }, DEFAULT_LIMITS.HEARTBEAT_INTERVAL_MS)

  return {
    stop: () => {
      clearInterval(interval)
    },
  }
}

// === Startup timeout ===

export function enforceStartupTimeout(
  pluginId: string,
  startedAt: number,
  timeoutMs: number,
  onTimeout: (pluginId: string) => void,
): { clear: () => void } {
  const timer = setTimeout(() => {
    const entry = getRuntime(pluginId)
    if (!entry) return

    if (entry.state === "starting") {
      onTimeout(pluginId)
    }
  }, timeoutMs)

  return {
    clear: () => {
      clearTimeout(timer)
    },
  }
}

// === Request timeout ===

export function createRequestTimeout(
  pluginId: string,
  requestId: string,
  timeoutMs: number,
  onTimeout: (pluginId: string, requestId: string) => void,
): { clear: () => void } {
  const timer = setTimeout(() => {
    onTimeout(pluginId, requestId)
  }, timeoutMs)

  return {
    clear: () => {
      clearTimeout(timer)
    },
  }
}

// === Graceful shutdown timeout ===

export function enforceShutdownTimeout(
  pluginId: string,
  timeoutMs: number,
  onTimeout: (pluginId: string) => void,
): { clear: () => void } {
  const timer = setTimeout(() => {
    onTimeout(pluginId)
  }, timeoutMs)

  return {
    clear: () => {
      clearTimeout(timer)
    },
  }
}
