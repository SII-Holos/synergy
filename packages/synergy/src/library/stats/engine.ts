import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Rollup } from "./rollup"
import type { LibraryStatsSnapshot } from "./types"

export namespace Engine {
  /**
   * Compute a fresh library stats snapshot from the SQLite database
   * and cache it in storage.
   */
  export async function recompute(): Promise<LibraryStatsSnapshot> {
    const snapshot = Rollup.snapshot()
    await Storage.write(StoragePath.librarySnapshot(), snapshot)
    return snapshot
  }

  /**
   * Get the library stats snapshot — returns cached if available,
   * otherwise computes and caches.
   */
  export async function get(): Promise<LibraryStatsSnapshot> {
    try {
      const cached = await Storage.read<LibraryStatsSnapshot>(StoragePath.librarySnapshot())
      if (cached) return cached
    } catch {
      // Cache miss or corrupted — recompute
    }
    return recompute()
  }
}
