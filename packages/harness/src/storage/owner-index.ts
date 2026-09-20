import { Storage } from "./storage"
import { STORAGE_RECORDS_OWNER_INDEX } from "./transactional-store"

/**
 * Creates the index retention's owner enumeration seeks.
 *
 * The open path creates this from the schema array, so a store that is opened
 * once after the upgrade has it. This migration exists for the stores that were
 * never opened with the new schema and for the ordering guarantee it provides:
 * the enumeration starts seeking on the first retention pass after the upgrade
 * instead of after the first open that happens to rebuild the schema.
 *
 * The statement is `CREATE INDEX IF NOT EXISTS`, so it is a no-op on a fresh
 * install and re-running it after an interrupted build converges. The DDL is the
 * same constant the schema array uses, so the two cannot drift.
 *
 * A large store builds this index by reading every record, which outlasts the
 * ordinary request deadline; `maintainDdl` runs it on the maintenance budget so
 * a build cannot be killed and then repeated on the next open.
 */
export namespace StorageRecordsOwnerIndex {
  export const id = "20260920-storage-records-owner-index"
  export const index = "storage_records_owner"

  export async function run() {
    await Storage.current().store.maintainDdl(STORAGE_RECORDS_OWNER_INDEX)
  }
}
