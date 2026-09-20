import { Storage } from "./storage"

/**
 * Drops the retired `storage_records_scope` index.
 *
 * The index is gone from the schema, but a store created before this change
 * still has it on disk: removing only the `CREATE` would leave every existing
 * database maintaining an index whose written form is never chosen for the read
 * shapes production issues. Retention's `evidenceOwners` groups rollout rows by
 * `scope_id`/`session_id`, and the scope-keyed record page filters on
 * `kind` and orders by `order_key`, both of which the planner answers from
 * `storage_records_kind`. `DROP INDEX IF EXISTS` is supported by both engines and
 * is a no-op where the index is already absent, so this is idempotent and safe on
 * a fresh install.
 */
export namespace StorageDropScopeIndex {
  export const id = "20260920-storage-drop-scope-index"
  export const index = "storage_records_scope"

  export async function run() {
    await Storage.current().store.dropIndexIfExists(index)
  }
}
