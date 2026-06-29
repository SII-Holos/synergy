import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import type { PersistedRuntimeEntry, RuntimeEntry } from "./registry.js"
import { Log } from "../util/log"

const log = Log.create({ service: "plugin-runtime.state-persist" })

const STATE_FILE = "plugin-runtime-state.json"

function stateFilePath(): string {
  return path.join(Global.Path.data, STATE_FILE)
}

export async function writeRuntimeState(entries: RuntimeEntry[]): Promise<void> {
  const persisted: PersistedRuntimeEntry[] = entries.map((e) => ({
    pluginId: e.pluginId,
    mode: e.mode,
    pid: e.pid,
    state: e.state,
    restarts: e.restarts,
    lastHeartbeatAt: e.lastHeartbeatAt,
    startedAt: e.startedAt,
    lastError: e.lastError,
    entryPath: e.entryPath,
    pluginDir: e.pluginDir,
    source: e.source,
    serverUrl: e.serverUrl,
    limits: e.limits,
    launchSignature: e.launchSignature,
  }))
  try {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(stateFilePath(), JSON.stringify(persisted, null, 2))
  } catch (err) {
    log.warn("failed to write runtime state", { error: err })
  }
}

export async function readRuntimeState(): Promise<PersistedRuntimeEntry[]> {
  try {
    const text = await Bun.file(stateFilePath()).text()
    const raw = JSON.parse(text) as PersistedRuntimeEntry[]
    const now = Date.now()
    const ONE_HOUR_MS = 60 * 60 * 1000

    return raw
      .filter((entry) => {
        // Don't restore entries older than 1 hour
        if (entry.startedAt && now - entry.startedAt > ONE_HOUR_MS) {
          return false
        }
        return true
      })
      .map((entry) => {
        // Processes don't survive restart — clean up state
        if (entry.state === "ready" || entry.state === "unhealthy") {
          entry.state = "stopped"
        } else if (entry.state === "starting") {
          entry.state = "crashed"
          entry.lastError = entry.lastError ?? "Server restarted during startup"
        }
        return entry
      })
  } catch {
    return []
  }
}
