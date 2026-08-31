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

  let source: Source | undefined

  export function register(value: Source): void {
    source = value
  }

  export function get(): Source | undefined {
    return source
  }

  export function listOwnership(): Promise<OwnershipRow[]> {
    return source?.() ?? Promise.resolve([])
  }
}
