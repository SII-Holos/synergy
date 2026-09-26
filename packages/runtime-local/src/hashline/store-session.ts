import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
/**
 * Session-scoped hashline snapshot store adapter.
 * Wraps InMemorySnapshotStore with WorkspaceState + Bus SessionEvent.Deleted cleanup.
 */
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { InMemorySnapshotStore, type SnapshotStore } from "./snapshots"

export namespace SessionSnapshotStore {
  const state = WorkspaceState.create(() => new Map<string, InMemorySnapshotStore>())

  const runtimeState = RuntimeContext.state(() => ({
    cleanupSubscribed: false,
  }))

  function ensureCleanupSubscription(): void {
    const instanceState = runtimeState()

    if (instanceState.cleanupSubscribed) return
    instanceState.cleanupSubscribed = true
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
