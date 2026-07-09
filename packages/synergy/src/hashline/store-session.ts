/**
 * Session-scoped hashline snapshot store adapter.
 * Wraps InMemorySnapshotStore with ScopedState + Bus SessionEvent.Deleted cleanup.
 */
import { Bus } from "../bus"
import { ScopedState } from "../scope/scoped-state"
import { SessionEvent } from "../session/event"
import { InMemorySnapshotStore, type SnapshotStore } from "./snapshots"

export namespace SessionSnapshotStore {
  const DEFAULT_SESSION_MAX_BYTES = 16 * 1024 * 1024
  const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000

  type Entry = {
    store: InMemorySnapshotStore
    lastAccessAt: number
    idleTimer?: ReturnType<typeof setTimeout>
  }

  const allStores = new Set<Map<string, Entry>>()
  const state = ScopedState.create(
    () => {
      const stores = new Map<string, Entry>()
      allStores.add(stores)
      return stores
    },
    async (stores) => {
      clearFrom(stores)
      allStores.delete(stores)
    },
  )
  const cleanupSubscribed = new WeakSet<Map<string, Entry>>()

  function envNumber(name: string, fallback: number) {
    const raw = process.env[name]
    if (!raw) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback
    return parsed
  }

  function sessionMaxBytes() {
    return envNumber("SYNERGY_HASHLINE_SESSION_MAX_BYTES", DEFAULT_SESSION_MAX_BYTES)
  }

  function idleTtlMs() {
    return envNumber("SYNERGY_HASHLINE_SESSION_IDLE_TTL_MS", DEFAULT_IDLE_TTL_MS)
  }

  function ensureCleanupSubscription(stores: Map<string, Entry>): void {
    if (cleanupSubscribed.has(stores)) return
    cleanupSubscribed.add(stores)
    Bus.subscribe(SessionEvent.Deleted, (event) => {
      clearFrom(stores, event.properties.info.id)
    })
    Bus.subscribe(SessionEvent.Idle, (event) => {
      scheduleIdleClear(stores, event.properties.sessionID)
    })
  }

  function scheduleIdleClear(stores: Map<string, Entry>, sessionID: string): void {
    const entry = stores.get(sessionID)
    if (!entry) return
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    const ttl = idleTtlMs()
    entry.idleTimer = setTimeout(() => {
      const current = stores.get(sessionID)
      if (!current) return
      if (Date.now() - current.lastAccessAt < ttl) return
      clearFrom(stores, sessionID)
    }, ttl)
    entry.idleTimer.unref?.()
  }

  function touch(entry: Entry) {
    entry.lastAccessAt = Date.now()
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
  }

  export function get(sessionID: string): SnapshotStore {
    const stores = state()
    ensureCleanupSubscription(stores)
    let entry = stores.get(sessionID)
    if (!entry) {
      entry = {
        store: new InMemorySnapshotStore({ maxTotalBytes: sessionMaxBytes() }),
        lastAccessAt: Date.now(),
      }
      stores.set(sessionID, entry)
    }
    touch(entry)
    return entry.store
  }

  function clearFrom(stores: Map<string, Entry>, sessionID?: string): void {
    if (sessionID) {
      const entry = stores.get(sessionID)
      if (entry?.idleTimer) clearTimeout(entry.idleTimer)
      entry?.store.clear()
      stores.delete(sessionID)
    } else {
      for (const entry of stores.values()) {
        if (entry.idleTimer) clearTimeout(entry.idleTimer)
        entry.store.clear()
      }
      stores.clear()
    }
  }

  export function clear(sessionID?: string): void {
    clearFrom(state(), sessionID)
  }

  export function stats() {
    let sessions = 0
    let totalBytes = 0
    const largest: Array<{
      sessionID: string
      bytes: number
      paths: number
      versions: number
      idleMs: number
    }> = []
    for (const stores of allStores) {
      for (const [sessionID, entry] of stores) {
        const storeStats = entry.store.stats()
        sessions++
        totalBytes += storeStats.totalBytes
        if (storeStats.totalBytes > 0) {
          largest.push({
            sessionID,
            bytes: storeStats.totalBytes,
            paths: storeStats.paths,
            versions: storeStats.versions,
            idleMs: Date.now() - entry.lastAccessAt,
          })
        }
      }
    }
    largest.sort((a, b) => b.bytes - a.bytes)
    return { scopes: allStores.size, sessions, totalBytes, largest: largest.slice(0, 10) }
  }
}
