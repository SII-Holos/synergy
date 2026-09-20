import { RecordCodec } from "./record-codec"
import { StorageIntegrityError } from "./errors"
import {
  STORAGE_NODES_PARENT_INDEX,
  artifactsTableDdl,
  keyBytes,
  nodesTableDdl,
  recordsTableDdl,
  storageArtifactsIndexes,
  storageRecordsIndexes,
  type TransactionalStore,
} from "./transactional-store"
import type { SqlConnection, SqlValue } from "./sql-contract"
import { Log } from "../util/log"
import { ObservabilityIssues } from "../observability/issues"

const recordsTable = "storage_records_v3"
const nodesTable = "storage_nodes_v3"
const artifactsTable = "storage_artifacts_v3"
const BATCH = 256
// A phase names work that is *not yet done*, so a cursor is cleared only when the
// work it belongs to finishes. The state lives in its own table rather than in
// `storage_records` for two reasons: the rewrite drops and renames that table, so
// a state row there would have to be carried across the swap by hand, and a
// bookkeeping row inside the record space would make `scan`, `list`, `query` and
// portable export differ before and after the rewrite even though no stored
// evidence changed.
const stateTable = "storage_format_v3_state"
// One reclaim call is bounded by this page count and by the maintenance engine's
// own deadline, so no single statement can occupy the worker past its ceiling.
// Retention uses the same value. The loop deliberately has no total-call ceiling:
// a ceiling that could trigger on a store that is still converging would leave
// pages unclaimed in the one run the migration gets, which is the defect this
// phase exists to fix. Termination rests on the freelist emptying or on progress
// stopping, and every call reports progress so startup keeps renewing its health
// deadline rather than looking stalled.
const RECLAIM_PAGES = 8192
// Consecutive calls allowed to release nothing before the phase gives up. A call
// can legitimately return zero while free pages remain: `SqliteMaintenance.reclaim`
// spends part of its budget on a `wal_checkpoint(PASSIVE)` before it vacuums, so a
// busy WAL can consume the whole call. Retrying past that is what separates a
// transient zero from a genuine stall.
const RECLAIM_STALL_TOLERANCE = 3
type Phase = "records" | "nodes" | "artifacts" | "swap" | "reclaim" | "complete"
const log = Log.create({ service: "storage.format-v3" })
type State = {
  version: 3
  phase: Phase
  recordsCursor: string
  nodesCursor: string
  artifactsCursor: string
}

type RecordsRow = {
  key_id: string
  key_text: string
  body: string | Uint8Array | null
  revision: bigint | number
  kind: string
  scope_id: string
  session_id: string
  message_id: string
  order_key: string
  updated: bigint | number
}

const emptyState = (): State => ({
  version: 3,
  phase: "records",
  recordsCursor: "",
  nodesCursor: "",
  artifactsCursor: "",
})

/**
 * Rewrites an existing store into format 3.
 *
 * Format 3 stores the raw sha256 of a logical key in a key column declared
 * `BLOB`, drops the per-node cumulative path text, bounds the message index to
 * rows that actually carry a message, and derives the artifact pack from its
 * location JSON.
 *
 * Each replacement table is built alongside the live one in bounded batches, and
 * every table is swapped in one transaction. Swapping them separately would be
 * unsafe: traversal joins `storage_records.key_id` to `storage_nodes.key_id`, so
 * a window in which one table holds byte keys and the other still holds hex text
 * keys makes every prefix walk return nothing. One transaction also means an
 * interruption leaves a fully readable store in one format or the other, never a
 * mixture.
 *
 * The recorded namespace version is written by that same swap transaction. That
 * is the one ordering that cannot leave a store claiming format 3 while still
 * holding format 2 rows: `TransactionalStore.open` deliberately does not promote
 * an existing namespace, and this migration -- not the open path -- stamps the
 * new format once the bytes are in place.
 *
 * Once the swap commits, a bounded reclaim phase returns the pages it freed. The
 * swap builds a second copy of each table before dropping the first, so it
 * necessarily leaves the old tables' pages on the SQLite freelist, and nothing
 * else returns them: retention reclaims only after it actually pruned, and a
 * store that has just shrunk is under its budget by definition. Without this
 * phase the rewrite leaves the store larger on disk than it was before it ran,
 * which is the opposite of what it exists for.
 */
export namespace StorageFormatV3Migration {
  export const id = "20260920-storage-format-v3"

  export async function run(options: {
    store: TransactionalStore
    progress?: (current: number, total: number, phase: number) => void
  }): Promise<void> {
    const { store, progress } = options
    // The layout depends on a column with no affinity, which PostgreSQL cannot
    // express; it keeps the format 2 layout and needs no rewrite.
    if (store.options.backend !== "sqlite") return
    await createStateTable(store)
    let state = await readState(store)
    // A namespace created at format 3 wrote its version at open and never wrote a
    // migration row, so there is nothing to rewrite.
    if (!state && store.keyEncodedAs === "bytes") return
    if (state && state.version !== 3) throw new StorageIntegrityError("Unsupported storage format migration version")
    if (state?.phase === "complete") return
    state = await copyRecords(store, state ?? emptyState(), progress)
    state = await copyNodes(store, state, progress)
    state = await copyArtifacts(store, state, progress)
    state = await swap(store, state, progress)
    await reclaim(store, state, progress)
  }

  /**
   * Rebuilds `storage_nodes` from the live records.
   *
   * The node table is derived: its rows are exactly the prefixes of the live
   * record keys. Anything else -- a path left behind by an interrupted deletion --
   * is garbage traversal cannot use and `verify()` reports. Rebuilding is
   * therefore the repair, and it is the same derivation the format rewrite
   * performs.
   */
  export async function rebuildNodes(store: TransactionalStore): Promise<void> {
    if (store.options.backend !== "sqlite") return
    await store.maintainDdlTransaction([
      { statement: `DROP TABLE IF EXISTS ${nodesTable}` },
      { statement: nodesTableDdl("sqlite", nodesTable) },
      { statement: "DROP TABLE storage_nodes" },
      { statement: `ALTER TABLE ${nodesTable} RENAME TO storage_nodes` },
      { statement: STORAGE_NODES_PARENT_INDEX },
    ])
    await deriveNodes(store, "storage_nodes", "", () => {})
  }

  async function createStateTable(store: TransactionalStore) {
    await store.maintainDdlTransaction([
      { statement: `CREATE TABLE IF NOT EXISTS ${stateTable} (namespace TEXT PRIMARY KEY, state TEXT NOT NULL)` },
    ])
  }

  async function readState(store: TransactionalStore): Promise<State | undefined> {
    return store.snapshot(
      async (tx) => {
        const [row] = await tx.raw.query<{ state: string }>(`SELECT state FROM ${stateTable} WHERE namespace = ?`, [
          store.options.namespace,
        ])
        return row ? (JSON.parse(String(row.state)) as State) : undefined
      },
      { singleStatement: true },
    )
  }

  async function writeState(store: TransactionalStore, state: State) {
    await store.maintainDdlTransaction([
      {
        statement: `INSERT INTO ${stateTable}(namespace, state) VALUES (?, ?) ON CONFLICT(namespace) DO UPDATE SET state = excluded.state`,
        values: [store.options.namespace, JSON.stringify(state)],
      },
    ])
  }

  async function copyRecords(
    store: TransactionalStore,
    state: State,
    progress?: (current: number, total: number, phase: number) => void,
  ): Promise<State> {
    if (state.phase !== "records") return state
    progress?.(0, 0, 1)
    // The replacement is created without its secondary indexes: every index would
    // be maintained by each copied row, and the swap builds them once from the
    // finished table instead.
    await store.maintainDdlTransaction([{ statement: recordsTableDdl("sqlite", recordsTable) }])
    let cursor = state.recordsCursor
    let copied = 0
    for (;;) {
      const rows = await store.transaction(async (tx) => {
        const page = await tx.raw.query<RecordsRow>(
          "SELECT key_id, key_text, body, revision, kind, scope_id, session_id, message_id, order_key, updated FROM storage_records WHERE namespace = ? AND key_id > ? ORDER BY key_id LIMIT ?",
          [store.options.namespace, cursor, BATCH],
        )
        if (!page.length) return []
        const values: SqlValue[] = []
        for (const row of page) {
          const keyText = JSON.parse(row.key_text) as string[]
          const bytes = keyBytes(keyText)
          // The copy converts a hex key into its bytes, so the digest must be the
          // one the recorded key text actually names. A mismatch would silently
          // re-key stored evidence to a path its own key text does not describe.
          if (Buffer.from(bytes).toString("hex") !== row.key_id)
            throw new StorageIntegrityError("Stored key identity disagrees with its recorded key text")
          values.push(
            store.options.namespace,
            bytes,
            row.key_text,
            // A tombstone carries no body and must never be re-encoded into one.
            row.body === null ? null : RecordCodec.reencode(row.body),
            row.revision,
            row.kind,
            row.scope_id,
            row.session_id,
            row.message_id,
            row.order_key,
            row.updated,
          )
        }
        await tx.raw.query(
          `INSERT OR REPLACE INTO ${recordsTable}(namespace, key_id, key_text, body, revision, kind, scope_id, session_id, message_id, order_key, updated) VALUES ${page.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",")}`,
          values,
        )
        return page
      })
      if (!rows.length) break
      copied += rows.length
      cursor = rows.at(-1)!.key_id
      // The cursor is durable before the next batch starts, so a crash between
      // batches resumes past the rows already copied instead of repeating them.
      // The copy is `INSERT OR REPLACE` by primary key, so even a cursor that
      // lags a committed batch only rewrites rows that are already correct.
      state = { ...state, recordsCursor: cursor }
      await writeState(store, state)
      progress?.(copied, 0, 1)
    }
    state = { ...state, phase: "nodes", recordsCursor: "", nodesCursor: "" }
    await writeState(store, state)
    return state
  }

  async function copyNodes(
    store: TransactionalStore,
    state: State,
    progress?: (current: number, total: number, phase: number) => void,
  ): Promise<State> {
    if (state.phase !== "nodes") return state
    progress?.(0, 0, 2)
    // Nodes are derived, so a resumed phase re-derives into a table it owns from
    // empty. Merging into a partial copy would need the exact cursor the
    // interrupted run reached, and a rebuild from the start is idempotent for the
    // same cost.
    await store.maintainDdlTransaction([
      { statement: `DROP TABLE IF EXISTS ${nodesTable}` },
      { statement: nodesTableDdl("sqlite", nodesTable) },
    ])
    await deriveNodes(store, nodesTable, "", (derived) => progress?.(derived, 0, 2))
    state = { ...state, phase: "artifacts", nodesCursor: "" }
    await writeState(store, state)
    return state
  }

  async function copyArtifacts(
    store: TransactionalStore,
    state: State,
    progress?: (current: number, total: number, phase: number) => void,
  ): Promise<State> {
    if (state.phase !== "artifacts") return state
    progress?.(0, 0, 3)
    await store.maintainDdlTransaction([
      { statement: `DROP TABLE IF EXISTS ${artifactsTable}` },
      { statement: artifactsTableDdl("sqlite", artifactsTable) },
    ])
    let cursor = state.artifactsCursor
    let copied = 0
    for (;;) {
      const rows = await store.transaction(async (tx) => {
        const page = await tx.raw.query<{ key_text: string; owner_key: string; location: string }>(
          "SELECT key_text, owner_key, location FROM storage_artifacts WHERE namespace = ? AND key_text > ? ORDER BY key_text LIMIT ?",
          [store.options.namespace, cursor, BATCH],
        )
        if (!page.length) return []
        const values: SqlValue[] = []
        for (const row of page) values.push(store.options.namespace, row.key_text, row.owner_key, row.location)
        await tx.raw.query(
          `INSERT OR REPLACE INTO ${artifactsTable}(namespace, key_text, owner_key, location) VALUES ${page.map(() => "(?, ?, ?, ?)").join(",")}`,
          values,
        )
        return page
      })
      if (!rows.length) break
      copied += rows.length
      cursor = rows.at(-1)!.key_text
      state = { ...state, artifactsCursor: cursor }
      await writeState(store, state)
      progress?.(copied, 0, 3)
    }
    state = { ...state, phase: "swap", artifactsCursor: "" }
    await writeState(store, state)
    return state
  }

  /**
   * Derives node rows from the live records into `table`.
   *
   * Only live records contribute: a tombstoned record keeps its revision row as a
   * deletion fence, but traversal cannot reach it, so building a path for it
   * would leave a node nothing lives at -- exactly the garbage `verify()` reports.
   * Batches are bounded by record key so the derivation cannot grow into one
   * statement on a large store.
   */
  async function deriveNodes(
    store: TransactionalStore,
    table: string,
    startCursor: string,
    progress: (derived: number) => void,
  ): Promise<void> {
    let cursor = startCursor
    let derived = 0
    for (;;) {
      const rows = await store.transaction(async (tx) => {
        const page = await tx.raw.query<{ key_id: string; key_text: string }>(
          "SELECT key_id, key_text FROM storage_records WHERE namespace = ? AND body IS NOT NULL AND key_id > ? ORDER BY key_id LIMIT ?",
          [store.options.namespace, cursor, BATCH],
        )
        if (!page.length) return []
        await writeNodes(store, tx.raw, table, page)
        return page
      })
      if (!rows.length) break
      derived += rows.length
      cursor = rows.at(-1)!.key_id
      progress(derived)
    }
  }

  async function writeNodes(
    store: TransactionalStore,
    connection: SqlConnection,
    table: string,
    rows: Array<{ key_id: string; key_text: string }>,
  ) {
    const nodes = new Map<string, SqlValue[]>()
    for (const row of rows) {
      const key = JSON.parse(row.key_text) as string[]
      for (let depth = 1; depth <= key.length; depth++) {
        const prefix = key.slice(0, depth)
        const bytes = keyBytes(prefix)
        nodes.set(Buffer.from(bytes).toString("hex"), [
          store.options.namespace,
          bytes,
          // The root's parent is the digest of the empty key, which is what the
          // write path binds; a zero-filled id would make every top-level node
          // unreachable from `scan([])`.
          keyBytes(prefix.slice(0, -1)),
          prefix.at(-1)!,
        ])
      }
    }
    const values = [...nodes.values()]
    for (let offset = 0; offset < values.length; offset += 128) {
      const group = values.slice(offset, offset + 128)
      await connection.query(
        `INSERT INTO ${table}(namespace, key_id, parent_id, segment) VALUES ${group.map(() => "(?, ?, ?, ?)").join(",")} ON CONFLICT(namespace, key_id) DO NOTHING`,
        group.flat(),
      )
    }
  }

  async function swap(
    store: TransactionalStore,
    state: State,
    progress?: (current: number, total: number, phase: number) => void,
  ): Promise<State> {
    // Only the `swap` phase may run this. The recorded phase advances to `reclaim`
    // inside this same transaction, so a run resumed after it must not drop the
    // byte-encoded tables and rename staging tables that no longer exist.
    if (state.phase !== "swap") return state
    progress?.(0, 0, 4)
    const namespace = store.options.namespace
    const next: State = { ...state, phase: "reclaim" }
    await store.maintainDdlTransaction([
      { statement: "DROP TABLE storage_records" },
      { statement: `ALTER TABLE ${recordsTable} RENAME TO storage_records` },
      { statement: "DROP TABLE storage_nodes" },
      { statement: `ALTER TABLE ${nodesTable} RENAME TO storage_nodes` },
      { statement: "DROP TABLE storage_artifacts" },
      { statement: `ALTER TABLE ${artifactsTable} RENAME TO storage_artifacts` },
      // `DROP TABLE` took every index with the dropped tables, so these rebuilds
      // are the only ones. They run on the maintenance budget because each reads
      // a whole table.
      ...storageRecordsIndexes("sqlite").map((statement) => ({ statement })),
      { statement: STORAGE_NODES_PARENT_INDEX },
      ...storageArtifactsIndexes.map((statement) => ({ statement })),
      // The recorded format, the namespace version and the terminal phase all
      // change in the same transaction as the tables they describe, so no
      // observer can see format 3 recorded over format 2 rows, and re-entry can
      // never mistake a finished rewrite for an unfinished one.
      {
        statement: `INSERT INTO ${stateTable}(namespace, state) VALUES (?, ?) ON CONFLICT(namespace) DO UPDATE SET state = excluded.state`,
        values: [namespace, JSON.stringify(next)] as SqlValue[],
      },
      { statement: "UPDATE storage_namespaces SET version = 3 WHERE namespace = ?", values: [namespace] as SqlValue[] },
    ])
    // Reads declare a single-statement contract and cannot re-read the format per
    // statement, so the store adopts the byte encoding in the process that
    // performed the swap.
    store.adoptFormatV3()
    progress?.(1, 1, 4)
    return next
  }

  /**
   * Returns the pages the swap freed, in bounded chunks.
   *
   * The swap builds a second copy of each table before dropping the first, so it
   * leaves the old tables' pages on the SQLite freelist. Nothing else returns
   * them: `StorageRetention.run` reclaims only after it actually pruned, and a
   * store that has just shrunk is under its budget by definition. Without this
   * phase the rewrite leaves the store larger on disk than it was before it ran.
   *
   * Each call is bounded by `maxPages` and by the maintenance engine's own
   * deadline, and the loop never merges them into one statement: an unbounded
   * `incremental_vacuum` over a multi-million page freelist would hold the worker
   * past its ceiling. A call is reported as it completes, so a long reclaim keeps
   * renewing the startup health deadline.
   *
   * The loop ends when the freelist is empty, or when progress stops:
   *
   * - `PRAGMA incremental_vacuum` is a silent no-op unless the database is in
   *   `INCREMENTAL` auto-vacuum mode, so on any other mode the freelist stays
   *   non-empty forever and a `while (freelist > 0)` loop would never terminate.
   *   That mode is detected directly and ends the loop on the first call.
   * - Otherwise a zero-release call is retried past `RECLAIM_STALL_TOLERANCE`,
   *   because a call whose budget went to its own checkpoint returns zero while
   *   free pages remain.
   *
   * In both stopping cases the phase stays `reclaim` and the condition is
   * reported rather than thrown: the rewrite itself succeeded and the store is
   * fully readable, so failing the migration would strand a valid format 3
   * namespace. Leaving the phase unclaimed is what keeps the remaining pages
   * resumable, since the copy phases short-circuit on the recorded phase and the
   * swap refuses to run again.
   */
  async function reclaim(
    store: TransactionalStore,
    state: State,
    progress?: (current: number, total: number, phase: number) => void,
  ): Promise<State> {
    if (state.phase !== "reclaim") return state
    progress?.(0, 0, 5)
    let released = 0
    let calls = 0
    let noProgress = 0
    let freelistPages = 0
    let autoVacuum = ""
    for (;;) {
      const chunk = await store.maintain({ operation: "reclaim", maxPages: RECLAIM_PAGES })
      released += chunk.releasedPages
      calls++
      freelistPages = chunk.freelistPages
      autoVacuum = chunk.autoVacuum
      progress?.(released, 0, 5)
      if (freelistPages === 0) break
      if (chunk.releasedPages > 0) {
        noProgress = 0
        continue
      }
      noProgress++
      if (autoVacuum !== "incremental" || noProgress > RECLAIM_STALL_TOLERANCE) break
    }
    if (freelistPages === 0) {
      const complete: State = { ...state, phase: "complete" }
      await writeState(store, complete)
      return complete
    }
    const reason = autoVacuum === "incremental" ? "no-progress" : `auto-vacuum-${autoVacuum || "unknown"}`
    log.warn("format 3 rewrite left free pages unreturned", {
      namespace: store.options.namespace,
      reason,
      releasedPages: released,
      freelistPages,
      calls,
      autoVacuum,
    })
    ObservabilityIssues.raise({
      code: "STORAGE_FORMAT_V3_RECLAIM_INCOMPLETE",
      severity: "warning",
      module: "storage",
      title: "Format 3 rewrite could not return every freed page",
      message:
        "The format 3 rewrite committed and the store is fully readable, but its freed pages remain on the SQLite freelist instead of being returned to the filesystem, so the file keeps the size it reached during the rewrite.",
      recommendation:
        "Confirm the authoritative database is in incremental auto-vacuum mode; without it, `PRAGMA incremental_vacuum` is a silent no-op and the freed pages cannot be returned. Re-running the storage-format-v3 migration resumes the reclaim without repeating the rewrite.",
      evidence: { reason, releasedPages: released, freelistPages, calls, autoVacuum },
    })
    return state
  }
}
