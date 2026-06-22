import { Log } from "@/util/log"
import type { PluginToHost, IsolatedPluginInputData } from "./protocol.js"
import { spawnPluginProcess } from "./process-host.js"
import { startHeartbeatMonitor, enforceStartupTimeout, DEFAULT_LIMITS } from "./health.js"

const log = Log.create({ service: "plugin-runtime.supervisor" })

// === Types ===

export type RuntimeMode = "in-process" | "worker" | "process"

export type RuntimeState = "starting" | "ready" | "unhealthy" | "stopped" | "crashed"

export interface RuntimeEntry {
  pluginId: string
  mode: RuntimeMode
  pid?: number
  state: RuntimeState
  restarts: number
  lastHeartbeatAt?: number
  memoryMb?: number
  startedAt?: number
  lastError?: string
  process?: Bun.Subprocess
}

// === Heartbeat monitors ===

const heartbeatMonitors = new Map<string, { stop: () => void }>()

function stopHeartbeatMonitor(pluginId: string): void {
  const monitor = heartbeatMonitors.get(pluginId)
  if (monitor) {
    monitor.stop()
    heartbeatMonitors.delete(pluginId)
  }
}
// === Registry ===

const runtimeRegistry = new Map<string, RuntimeEntry>()

export function getRuntime(pluginId: string): RuntimeEntry | undefined {
  return runtimeRegistry.get(pluginId)
}

export function getAllRuntimes(): RuntimeEntry[] {
  return Array.from(runtimeRegistry.values())
}

export function getRuntimeState(pluginId: string): RuntimeState {
  return runtimeRegistry.get(pluginId)?.state ?? "stopped"
}

// === Lifecycle ===

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000

export async function startRuntime(
  pluginId: string,
  options: {
    mode: RuntimeMode
    entryPath: string
    pluginDir: string
    scope?: import("../scope/types.js").Info
    serverUrl?: string
  },
): Promise<RuntimeEntry> {
  const existing = runtimeRegistry.get(pluginId)
  if (existing && existing.state !== "stopped" && existing.state !== "crashed") {
    log.warn("plugin already running", { pluginId, state: existing.state })
    return existing
  }

  // Fix 4: increment restarts if restarting from crashed/stopped
  const restarts =
    existing && (existing.state === "crashed" || existing.state === "stopped")
      ? existing.restarts + 1
      : existing
        ? existing.restarts
        : 0

  const entry: RuntimeEntry = {
    pluginId,
    mode: options.mode,
    state: "starting",
    restarts,
    startedAt: Date.now(),
  }

  runtimeRegistry.set(pluginId, entry)

  if (options.mode === "in-process") {
    log.info("plugin registered in-process", { pluginId })
    entry.state = "ready"
    return entry
  }

  if (options.mode === "worker") {
    log.error("worker mode not yet implemented", { pluginId })
    entry.state = "crashed"
    entry.lastError = "worker mode not yet implemented"
    return entry
  }

  // process mode — Fix 3: spawn real process via spawnPluginProcess
  try {
    const scope =
      options.scope ??
      ({
        id: "global",
        type: "global" as const,
        directory: options.pluginDir,
        worktree: options.pluginDir,
        time: { created: 0, updated: 0 },
        sandboxes: [],
      } as IsolatedPluginInputData["scope"])
    const serverUrl = options.serverUrl ?? "http://localhost:3000"

    const input: IsolatedPluginInputData = {
      pluginId,
      pluginDir: options.pluginDir,
      directory: scope.directory,
      scope,
      serverUrl,
    }

    const spawned = await spawnPluginProcess({
      pluginId,
      pluginDir: options.pluginDir,
      entryPath: options.entryPath,
      input,
      hostBridgeHandler: undefined, // will be wired by the plugin runtime system
    })

    entry.process = spawned.process
    entry.pid = spawned.process.pid

    // Fix 1: wire heartbeat updates from plugin messages
    spawned.onMessage((msg: PluginToHost) => {
      if (msg.type === "heartbeat") {
        entry.lastHeartbeatAt = Date.now()
      }
      if (msg.type === "ready") {
        entry.state = "ready"
        log.info("plugin ready", { pluginId })
      }
    })

    // Fix 6: start heartbeat monitor with unhealthy transition
    stopHeartbeatMonitor(pluginId)
    const monitor = startHeartbeatMonitor(pluginId, (missedPluginId, missCount) => {
      log.warn("heartbeat missed, marking unhealthy", { pluginId: missedPluginId, missCount })
      const e = runtimeRegistry.get(missedPluginId)
      if (e) {
        e.state = "unhealthy"
        e.lastError = `Missed ${missCount} heartbeats`
      }
    })
    heartbeatMonitors.set(pluginId, monitor)

    // Startup timeout enforcement
    enforceStartupTimeout(pluginId, entry.startedAt!, DEFAULT_LIMITS.STARTUP_TIMEOUT_MS, (timedOutPluginId) => {
      log.error("startup timeout", { pluginId: timedOutPluginId })
      const e = runtimeRegistry.get(timedOutPluginId)
      if (e && e.state === "starting") {
        e.state = "crashed"
        e.lastError = "Startup timeout"
        forceStop(e)
      }
    })

    log.info("plugin process spawned", { pluginId, pid: entry.pid })
    return entry
  } catch (err: any) {
    log.error("failed to spawn plugin process", { pluginId, error: err.message })
    entry.state = "crashed"
    entry.lastError = `Spawn failed: ${err.message}`
    return entry
  }
}

export async function stopRuntime(pluginId: string, graceful: boolean): Promise<void> {
  const entry = runtimeRegistry.get(pluginId)
  if (!entry) {
    log.warn("stopRuntime called for unknown plugin", { pluginId })
    return
  }

  if (entry.state === "stopped") return

  stopHeartbeatMonitor(pluginId)

  if (graceful && entry.process) {
    log.info("sending shutdown to plugin", { pluginId })
    // TODO: Send "shutdown" message over IPC
    const timeout = setTimeout(() => {
      log.warn("graceful shutdown timed out, force killing", { pluginId })
      forceStop(entry)
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS)

    // Wait for process to exit naturally
    try {
      await entry.process.exited
    } catch {
      // Process already dead
    }
    clearTimeout(timeout)
  } else {
    forceStop(entry)
  }

  entry.state = "stopped"
  entry.process = undefined
  entry.pid = undefined
  runtimeRegistry.set(pluginId, entry)
  log.info("plugin stopped", { pluginId })
}

function forceStop(entry: RuntimeEntry): void {
  if (entry.process) {
    try {
      entry.process.kill("SIGKILL")
    } catch {
      // Process may already be dead
    }
    entry.process = undefined
  }
}

export async function reloadRuntime(pluginId: string): Promise<RuntimeEntry> {
  const entry = runtimeRegistry.get(pluginId)
  if (!entry) {
    throw new Error(`Cannot reload unknown plugin: ${pluginId}`)
  }

  log.info("reloading plugin", { pluginId })
  await stopRuntime(pluginId, true)

  return startRuntime(pluginId, {
    mode: entry.mode,
    entryPath: "", // caller must re-resolve
    pluginDir: "", // caller must re-resolve
  })
}

export async function killRuntime(pluginId: string): Promise<void> {
  const entry = runtimeRegistry.get(pluginId)
  if (!entry) {
    log.warn("killRuntime called for unknown plugin", { pluginId })
    return
  }

  if (entry.state === "stopped") return

  forceStop(entry)
  entry.state = "stopped"
  entry.process = undefined
  entry.pid = undefined
  runtimeRegistry.set(pluginId, entry)
  log.info("plugin killed", { pluginId })
}
