import { RuntimeContext } from "../lifecycle/context"
/**
 * S9c source inversion: the L1 session navigation index annotates managed
 * Project scopes through this registry instead of importing the channel
 * product domain's ownership store. The L4 product manifest registers the
 * source; unregistered access degrades quietly (no managed Project rows).
 */
export namespace SessionManagedProjects {
  export interface OwnershipRow {
    scopeID: string
    channelType: string
    accountId: string
    externalProjectId: string
    remoteState: "active" | "paused" | "stale" | "archived"
  }

  type Source = () => Promise<OwnershipRow[]>

  const runtimeState = RuntimeContext.state(() => ({
    source: undefined as Source | undefined,
  }))

  export function register(value: Source): void {
    const instanceState = runtimeState()

    if (instanceState.source === value) return
    RuntimeContext.assertCompositionOpen("session/managed-projects")
    if (instanceState.source && value !== undefined) throw new Error("session/managed-projects is already registered")
    instanceState.source = value
  }

  export function get(): Source | undefined {
    const instanceState = runtimeState()

    return instanceState.source
  }

  export function listOwnership(): Promise<OwnershipRow[]> {
    const instanceState = runtimeState()

    return instanceState.source?.() ?? Promise.resolve([])
  }
}
