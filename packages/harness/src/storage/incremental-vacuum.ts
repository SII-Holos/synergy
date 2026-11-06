import { Storage } from "./storage"

/**
 * Converts the authoritative SQLite database to incremental auto-vacuum.
 *
 * SQLite only applies `auto_vacuum` to an empty database, so an existing one
 * must be rewritten by a full VACUUM during a migration window. The operation
 * runs inside the owning SQLite worker, is a no-op once the database already
 * reports `incremental`, and reports nothing to do for PostgreSQL, which keeps
 * no in-file freelist. A crash mid-VACUUM leaves the previous database intact
 * because SQLite does not commit the rewrite incrementally.
 */
export namespace StorageIncrementalVacuum {
  export const id = "20260918-storage-incremental-vacuum"

  export async function run(progress: (current: number, total: number, phase?: number) => void = () => {}) {
    progress(0, 0, 1)
    const result = await Storage.current().store.maintain({ operation: "enable-incremental-vacuum" })
    progress(1, 1, 1)
    return result
  }
}
