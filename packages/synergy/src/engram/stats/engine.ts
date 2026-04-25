import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Rollup } from "./rollup"
import type { EngramStatsSnapshot } from "./types"

export namespace Engine {
  /**
   * Compute a fresh engram stats snapshot from the SQLite database
   * and cache it in storage.
   */
  export async function recompute(): Promise<EngramStatsSnapshot> {
    const snapshot = Rollup.snapshot()
    await Storage.write(StoragePath.engramSnapshot(), snapshot)
    return snapshot
  }

  /**
   * Get the engram stats snapshot — returns cached if available,
   * otherwise computes and caches.
   */
  export async function get(): Promise<EngramStatsSnapshot> {
    try {
      const cached = await Storage.read<EngramStatsSnapshot>(StoragePath.engramSnapshot())
      if (cached) return cached
    } catch {
      // Cache miss or corrupted — recompute
    }
    return recompute()
  }
}
