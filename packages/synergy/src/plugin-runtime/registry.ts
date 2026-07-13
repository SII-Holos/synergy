import type { PluginDefinition } from "@ericsanchezok/synergy-plugin"
import type { PluginProcessHost } from "./process-host.js"

export type PluginRuntimeState = "starting" | "ready" | "draining" | "crashed" | "stopped"

export interface PluginRuntimeEntry {
  key: string
  pluginId: string
  version: string
  generation: string
  mode: "process" | "inProcess"
  state: PluginRuntimeState
  handlerIds: string[]
  process?: PluginProcessHost
  definition?: PluginDefinition
  inFlight: number
  startedAt: number
  lastHeartbeatAt?: number
  lastError?: string
}

export function pluginRuntimeKey(pluginId: string, version: string, generation: string): string {
  return `${pluginId}@${version}#${generation}`
}

export class PluginRuntimeRegistry {
  #entries = new Map<string, PluginRuntimeEntry>()
  #active = new Map<string, string>()

  set(entry: PluginRuntimeEntry) {
    this.#entries.set(entry.key, entry)
  }

  get(key: string) {
    return this.#entries.get(key)
  }

  active(pluginId: string) {
    const key = this.#active.get(pluginId)
    return key ? this.#entries.get(key) : undefined
  }

  activate(key: string): PluginRuntimeEntry | undefined {
    const entry = this.#entries.get(key)
    if (!entry) throw new Error(`Unknown plugin runtime generation: ${key}`)
    const previous = this.active(entry.pluginId)
    this.#active.set(entry.pluginId, key)
    return previous?.key === key ? undefined : previous
  }

  delete(key: string) {
    const entry = this.#entries.get(key)
    this.#entries.delete(key)
    if (entry && this.#active.get(entry.pluginId) === key) this.#active.delete(entry.pluginId)
  }

  list() {
    return [...this.#entries.values()]
  }
}
