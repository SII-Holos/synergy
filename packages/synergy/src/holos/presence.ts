import { Log } from "@/util/log"

const log = Log.create({ service: "holos.presence" })

export namespace Presence {
  export type Status = "online" | "offline" | "unknown"

  type Entry = {
    status: Status
    lastChecked: number
  }

  const cache = new Map<string, Entry>()
  const MAX_AGE_MS = 24 * 60 * 60 * 1000

  export function get(agentId: string): Status {
    const entry = cache.get(agentId)
    if (!entry) return "unknown"
    if (Date.now() - entry.lastChecked > MAX_AGE_MS) {
      cache.delete(agentId)
      return "unknown"
    }
    return entry.status
  }

  export function isOnline(agentId: string): boolean {
    return get(agentId) === "online"
  }

  export function markOnline(agentId: string): void {
    cache.set(agentId, { status: "online", lastChecked: Date.now() })
  }

  export function markOffline(agentId: string): void {
    cache.set(agentId, { status: "offline", lastChecked: Date.now() })
  }

  export function remove(agentId: string): void {
    cache.delete(agentId)
  }

  export function clear(): void {
    cache.clear()
  }

  export function prune(): void {
    const now = Date.now()
    for (const [id, entry] of cache) {
      if (now - entry.lastChecked > MAX_AGE_MS) cache.delete(id)
    }
  }

  export function all(): Map<string, Status> {
    const result = new Map<string, Status>()
    for (const [id, entry] of cache) {
      result.set(id, entry.status)
    }
    return result
  }
}
