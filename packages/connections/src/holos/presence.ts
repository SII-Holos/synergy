import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

const log = Log.create({ service: "holos.presence" })

export namespace Presence {
  export type Status = "online" | "offline" | "unknown"

  type Entry = {
    status: Status
    lastChecked: number
  }

  const runtimeState = RuntimeContext.state(() => ({
    cache: new Map<string, Entry>(),
    clock: (() => Date.now()) as () => number,
  }))
  const MAX_AGE_MS = 5 * 60 * 1000

  export function setClock(next: () => number): void {
    const instanceState = runtimeState()

    instanceState.clock = next
  }

  export function now(): number {
    const instanceState = runtimeState()

    return instanceState.clock()
  }

  export function get(agentId: string): Status {
    const instanceState = runtimeState()

    const entry = instanceState.cache.get(agentId)
    if (!entry) return "unknown"
    if (now() - entry.lastChecked > MAX_AGE_MS) {
      instanceState.cache.delete(agentId)
      return "unknown"
    }
    return entry.status
  }

  export function markOnline(agentId: string): void {
    const instanceState = runtimeState()

    instanceState.cache.set(agentId, { status: "online", lastChecked: now() })
  }

  export function markOffline(agentId: string): void {
    const instanceState = runtimeState()

    instanceState.cache.set(agentId, { status: "offline", lastChecked: now() })
  }

  export function remove(agentId: string): void {
    const instanceState = runtimeState()

    instanceState.cache.delete(agentId)
  }

  export function clear(): void {
    const instanceState = runtimeState()

    instanceState.cache.clear()
  }

  export function prune(): void {
    const instanceState = runtimeState()

    const current = now()
    for (const [id, entry] of instanceState.cache) {
      if (current - entry.lastChecked > MAX_AGE_MS) instanceState.cache.delete(id)
    }
  }

  export function all(): Map<string, Status> {
    const instanceState = runtimeState()

    const result = new Map<string, Status>()
    const current = now()
    for (const [id, entry] of instanceState.cache) {
      if (current - entry.lastChecked > MAX_AGE_MS) {
        instanceState.cache.delete(id)
        continue
      }
      result.set(id, entry.status)
    }
    return result
  }
}
