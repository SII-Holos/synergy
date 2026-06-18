/**
 * Session-scoped hashline snapshot store adapter.
 * Wraps InMemorySnapshotStore with Instance.state + Bus SessionEvent.Deleted cleanup.
 */
import { Bus } from "../bus"
import { Instance } from "../scope/instance"
import { SessionEvent } from "../session/event"
import { InMemorySnapshotStore, type SnapshotStore } from "./snapshots"

export namespace SessionSnapshotStore {
  const state = Instance.state(() => new Map<string, InMemorySnapshotStore>())

  let cleanupSubscribed = false

  function ensureCleanupSubscription(): void {
    if (cleanupSubscribed) return
    cleanupSubscribed = true
    Bus.subscribe(SessionEvent.Deleted, (event) => {
      clear(event.properties.info.id)
    })
  }

  export function get(sessionID: string): SnapshotStore {
    ensureCleanupSubscription()
    const stores = state()
    let store = stores.get(sessionID)
    if (!store) {
      store = new InMemorySnapshotStore()
      stores.set(sessionID, store)
    }
    return store
  }

  export function clear(sessionID?: string): void {
    const stores = state()
    if (sessionID) {
      stores.get(sessionID)?.clear()
      stores.delete(sessionID)
    } else {
      for (const store of stores.values()) store.clear()
      stores.clear()
    }
  }
}
