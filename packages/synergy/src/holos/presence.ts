import { Log } from "@/util/log"

const log = Log.create({ service: "holos.presence" })

export namespace Presence {
  export type Status = "online" | "offline" | "unknown"

  type Entry = {
    status: Status
    lastChecked: number
  }

  const cache = new Map<string, Entry>()
  const MAX_AGE_MS = 5 * 60 * 1000
  let clock: () => number = () => Date.now()

  export function setClock(next: () => number): void {
    clock = next
  }

  export function now(): number {
    return clock()
  }

  export function get(agentId: string): Status {
    const entry = cache.get(agentId)
    if (!entry) return "unknown"
    if (now() - entry.lastChecked > MAX_AGE_MS) {
      cache.delete(agentId)
      return "unknown"
    }
    return entry.status
  }

  export function markOnline(agentId: string): void {
    cache.set(agentId, { status: "online", lastChecked: now() })
  }

  export function markOffline(agentId: string): void {
    cache.set(agentId, { status: "offline", lastChecked: now() })
  }

  export function remove(agentId: string): void {
    cache.delete(agentId)
  }

  export function clear(): void {
    cache.clear()
  }

  export function prune(): void {
    const current = now()
    for (const [id, entry] of cache) {
      if (current - entry.lastChecked > MAX_AGE_MS) cache.delete(id)
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
