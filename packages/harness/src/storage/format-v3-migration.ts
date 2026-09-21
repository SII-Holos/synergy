import fs from "node:fs/promises"
import path from "node:path"
import { RecordCodec } from "./record-codec"
import { StorageIntegrityError } from "./errors"
import {
  STORAGE_NODES_PARENT_INDEX,
  artifactPackLayout,
  artifactsTableDdl,
  keyBytes,
  nodesTableDdl,
  recordsTableDdl,
  storageArtifactsIndexes,
  storageRecordsIndexes,
  type ArtifactPackLayout,
  type TransactionalStore,
} from "./transactional-store"
import type { SqlConnection, SqlRow, SqlValue } from "./sql-contract"
import { StorageFormatV3State } from "./format-v3-state"
import { UpgradeWork } from "./upgrade-work"
import { Log } from "../util/log"
import { ObservabilityIssues } from "../observability/issues"

const log = Log.create({ service: "storage.format-v3" })

const recordsTable = "storage_records_v3"
const nodesTable = "storage_nodes_v3"
const artifactsTable = "storage_artifacts_v3"
// The scratch table and index the capability probe builds. They are named after
// what they test rather than after the replacement table, so a probe left behind
// by a power loss names itself and the next run's `DROP TABLE IF EXISTS` repairs
// it. The index goes with the table, so no probe index can survive into the swap
// and be renamed onto the live table.
const artifactsProbeTable = "storage_artifacts_probe"
const artifactsProbeIndex = "storage_artifacts_probe_pack"
const BATCH = 256
// Rows examined to size a table the copy has not written yet. The sample is the
// lowest keys in the table's key order, which is a uniform slice of the namespace
// because a format 3 key column holds a sha256 rather than a name.
const PREFLIGHT_SAMPLE_ROWS = 256
// A phase names work that is *not yet done*, so a cursor is cleared only when the
// work it belongs to finishes. The state lives in its own table rather than in
// `storage_records` for two reasons: the rewrite drops and renames that table, so
// a state row there would have to be carried across the swap by hand, and a
// bookkeeping row inside the record space would make `scan`, `list`, `query` and
// portable export differ before and after the rewrite even though no stored
// evidence changed.
const stateTable = "storage_format_v3_state"
type State = StorageFormatV3State.State

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

type RecordSizeRow = {
  body: string | Uint8Array | null
  key_text: string
  kind: string
  scope_id: string
  session_id: string
  message_id: string
  order_key: string
}
type NodeSizeRow = { segment: string }
type ArtifactSizeRow = { key_text: string; owner_key: string; location: string }

function textBytes(value: string | null): number {
  return value === null ? 0 : Buffer.byteLength(value)
}

/** The bytes a body occupies once the copy has re-encoded it. */
function stagedBodyBytes(body: string | Uint8Array | null): number {
  if (body === null) return 0
  const encoded = RecordCodec.reencode(body)
  return typeof encoded === "string" ? Buffer.byteLength(encoded) : encoded.byteLength
}

/**
 * The index entry SQLite keeps beside a row of a non-integer `PRIMARY KEY`: the
 * key columns again, plus the rowid the index points at.
 */
function keyEntryBytes(namespaceBytes: number, keyColumnBytes: number): number {
  return namespaceBytes + keyColumnBytes + 8
}

/** Bytes as GiB to two decimals, so the shortfall reads as an operator can size it. */
function gib(bytes: number | bigint): string {
  return (Number(bytes) / 1024 ** 3).toFixed(2)
}

/**
 * The `pack` field of a stored artifact location, read the way the generated
 * column reads it.
 *
 * `json_extract(location, '$.pack')` reads that one field and nothing else, so
 * the fallback extracts the same field rather than validating the whole
 * document: a legacy row whose other fields a stricter reader would reject is
 * still a row the generated column copies happily, and the fallback must not fail
 * a rewrite the supported path completes. Malformed JSON fails either way, since
 * `json_extract` rejects it too.
 *
 * A valid document carrying no `pack` is the one case the two layouts cannot
 * share: the generated column stores `NULL` and the physical column is
 * `NOT NULL`. That row cannot be represented in the fallback layout at all, so it
 * is reported as the integrity problem it is instead of surfacing as a bare
 * `NOT NULL` constraint failure.
 */
function packFromLocation(location: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(location)
  } catch {
    throw new StorageIntegrityError("A stored artifact location is not valid JSON")
  }
  const pack = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).pack : undefined
  if (typeof pack !== "string") throw new StorageIntegrityError("A stored artifact location names no pack")
  return pack
}

const emptyState = (): State => ({
  version: 3,
  phase: "records",
  recordsCursor: "",
  nodesCursor: "",
  artifactsCursor: "",
  fenced: true,
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
 * Once the swap commits, the store is usable immediately. The remaining free
 * pages are recorded in the checkpoint and reclaimed by the independent idle
 * reclamation worker or an explicit maintenance command. Separating those
 * phases keeps the format upgrade's commit point bounded and makes a stalled
 * vacuum resumable without blocking ordinary startup.
 */
export namespace StorageFormatV3Migration {
  export const id = "20260920-storage-format-v3"

  export const state = StorageFormatV3State.read

  export async function isApplied(store: TransactionalStore) {
    if (store.options.backend !== "sqlite") return true
    const checkpoint = await state(store)
    if (store.keyEncodedAs !== "bytes") {
      if (checkpoint && ["reclaim", "complete"].includes(checkpoint.phase))
        throw new StorageIntegrityError("The recorded format and upgrade checkpoint disagree")
      return false
    }
    if (checkpoint && !["reclaim", "complete"].includes(checkpoint.phase))
      throw new StorageIntegrityError("The recorded format and upgrade checkpoint disagree")
    await store.snapshot(async (tx) => {
      const keys = await tx.raw.query<{ name: string; type: string }>(
        "SELECT name, type FROM pragma_table_xinfo('storage_records') WHERE name = 'key_id' UNION ALL SELECT name, type FROM pragma_table_xinfo('storage_nodes') WHERE name IN ('key_id', 'parent_id')",
      )
      const indexes = await tx.raw.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('storage_records_session', 'storage_records_owner', 'storage_records_message', 'storage_records_kind', 'storage_nodes_parent', 'storage_artifacts_owner', 'storage_artifacts_pack')",
      )
      if (keys.length !== 3 || keys.some((column) => column.type.toUpperCase() !== "BLOB") || indexes.length !== 7)
        throw new StorageIntegrityError(
          "The committed format layout is incomplete; preserve the database and export diagnostics",
        )
    })
    return true
  }

  export async function run(options: {
    store: TransactionalStore
    progress?: (current: number, total: number, phase: number) => void
    /**
     * Answers whether this engine accepts and can index the generated `pack`
     * column the format 3 layout derives from `location`.
     *
     * Injectable so a test can drive the fallback deterministically instead of
     * depending on what the host engine happens to support; production passes the
     * probe that asks the engine itself.
     */
    supportsGeneratedPack?: () => Promise<boolean>
  }): Promise<void> {
    const { store, progress } = options
    // The layout depends on a column with no affinity, which PostgreSQL cannot
    // express; it keeps the format 2 layout and needs no rewrite.
    if (store.options.backend !== "sqlite") return
    if (await isApplied(store)) return
    await createStateTable(store)
    let state = await readState(store)
    // A namespace created at format 3 wrote its version at open and never wrote a
    // migration row, so there is nothing to rewrite.
    if (!state && store.keyEncodedAs === "bytes") return
    if (state && state.version !== 3) throw new StorageIntegrityError("Unsupported storage format migration version")
    if (state?.phase === "complete" || state?.phase === "reclaim") return
    const [foreign] = await store.snapshot((tx) =>
      tx.raw.query("SELECT 1 FROM storage_namespaces WHERE namespace <> ? LIMIT 1", [store.options.namespace]),
    )
    if (foreign)
      throw new StorageIntegrityError("Format maintenance requires a database containing only its active namespace")
    if (state && (!state.fenced || state.invalidated)) {
      await store.maintainDdlTransaction([
        ...StorageFormatV3State.fences(false),
        ...[recordsTable, nodesTable, artifactsTable].map((table) => ({ statement: `DROP TABLE IF EXISTS ${table}` })),
      ])
      state = undefined
    }
    state ??= emptyState()
    await store.maintainDdlTransaction([
      {
        statement: `INSERT INTO ${stateTable}(namespace, state) VALUES (?, ?) ON CONFLICT(namespace) DO UPDATE SET state = excluded.state`,
        values: [store.options.namespace, JSON.stringify(state)],
      },
      ...StorageFormatV3State.fences(true),
    ])
    // Only a run that still has copy work ahead of it needs the headroom: a run
    // resumed at the swap or the reclaim has already finished building its second
    // copy, and demanding the peak again would refuse to finish a rewrite that is
    // mid-flight.
    if (state.phase === "records" || state.phase === "nodes" || state.phase === "artifacts")
      await preflightCapacity(store, state)
    state = await copyRecords(store, state, progress)
    state = await copyNodes(store, state, progress)
    state = await copyArtifacts(
      store,
      state,
      progress,
      options.supportsGeneratedPack ?? (() => supportsGeneratedArtifacts(store)),
    )
    state = await swap(store, state, progress)
  }

  /**
   * Refuses to start the copy phases without room for the copy they build.
   *
   * The rewrite builds each replacement table beside the live one before the swap
   * drops the original, so it transiently holds both. A volume that cannot hold
   * both currently fails part way through with a bare `SQLITE_FULL` that names
   * neither the cause nor the requirement; the legacy importers preflight the
   * same way with `statfs` before they write.
   *
   * The figure is derived from what the remaining copy actually writes: the exact
   * row count still to be stored in each table, scaled from a bounded sample of
   * real rows sized the way the copy stores them -- key columns as their byte
   * digest and bodies through `RecordCodec.reencode` -- plus the primary-key
   * entry SQLite keeps beside every row, which stores the key columns a second
   * time. Pages the swap has already freed are counted as room the run has. Page
   * overhead, index fill and the WAL are deliberately left out, so the figure is
   * a lower bound on the true peak, which is the direction that cannot refuse a
   * store that had room.
   */
  async function preflightCapacity(store: TransactionalStore, state: State) {
    const filename = store.sqliteFilename
    if (!filename) return
    const namespace = store.options.namespace
    const [shell] = await store.snapshot(
      (tx) =>
        tx.raw.query<{ pageSize: number; freeBytes: number }>(
          "SELECT (SELECT page_size FROM pragma_page_size()) AS pageSize, (SELECT freelist_count FROM pragma_freelist_count()) * (SELECT page_size FROM pragma_page_size()) AS freeBytes",
        ),
      { singleStatement: true },
    )
    const [counts] = await store.snapshot(
      (tx) =>
        tx.raw.query<{ records: number; nodes: number; artifacts: number }>(
          "SELECT (SELECT COUNT(*) FROM storage_records WHERE namespace = ?) AS records, (SELECT COUNT(*) FROM storage_nodes WHERE namespace = ?) AS nodes, (SELECT COUNT(*) FROM storage_artifacts WHERE namespace = ?) AS artifacts",
          [namespace, namespace, namespace],
        ),
      { singleStatement: true },
    )
    const records = Number(counts?.records ?? 0)
    const nodes = Number(counts?.nodes ?? 0)
    const artifacts = Number(counts?.artifacts ?? 0)
    const namespaceBytes = Buffer.byteLength(namespace)

    const averageRowBytes = async <Row extends SqlRow>(
      table: string,
      keyColumn: string,
      columns: string,
      sizeOf: (row: Row) => number,
    ): Promise<number> => {
      const sample = await store.snapshot(
        (tx) =>
          tx.raw.query<Row>(`SELECT ${columns} FROM ${table} WHERE namespace = ? ORDER BY ${keyColumn} LIMIT ?`, [
            namespace,
            PREFLIGHT_SAMPLE_ROWS,
          ]),
        { singleStatement: true },
      )
      if (!sample.length) return 0
      return sample.reduce((total, row) => total + sizeOf(row), 0) / sample.length
    }
    const remainingRows = async (table: string, keyColumn: string, cursor: string) => {
      if (!cursor) return 0
      const [row] = await store.snapshot(
        (tx) =>
          tx.raw.query<{ rows: number }>(
            `SELECT COUNT(*) AS rows FROM ${table} WHERE namespace = ? AND ${keyColumn} > ?`,
            [namespace, cursor],
          ),
        { singleStatement: true },
      )
      return Number(row?.rows ?? 0)
    }

    // Nodes are derived from record prefixes, so a record cursor does not give
    // their remaining count. Discount the actual durable staging rows instead.
    const recordsAhead =
      state.phase === "records"
        ? state.recordsCursor
          ? await remainingRows("storage_records", "key_id", state.recordsCursor)
          : records
        : 0
    const stagedNodes =
      state.phase === "nodes" && state.nodesCursor
        ? await store.snapshot(
            (tx) =>
              tx.raw.query<{ rows: number }>(`SELECT COUNT(*) AS rows FROM ${nodesTable} WHERE namespace = ?`, [
                namespace,
              ]),
            { singleStatement: true },
          )
        : undefined
    const nodesAhead =
      state.phase === "records" || state.phase === "nodes"
        ? Math.max(0, nodes - Number(stagedNodes?.[0]?.rows ?? 0))
        : 0
    const artifactsAhead =
      state.phase === "records" || state.phase === "nodes"
        ? artifacts
        : state.phase === "artifacts"
          ? state.artifactsCursor
            ? await remainingRows("storage_artifacts", "key_text", state.artifactsCursor)
            : artifacts
          : 0

    const staged =
      Math.ceil(
        (await averageRowBytes<RecordSizeRow>(
          "storage_records",
          "key_id",
          "body, key_text, kind, scope_id, session_id, message_id, order_key",
          (row) =>
            namespaceBytes +
            32 +
            textBytes(row.key_text) +
            stagedBodyBytes(row.body) +
            8 +
            textBytes(row.kind) +
            textBytes(row.scope_id) +
            textBytes(row.session_id) +
            textBytes(row.message_id) +
            textBytes(row.order_key) +
            8 +
            keyEntryBytes(namespaceBytes, 32),
        )) * recordsAhead,
      ) +
      Math.ceil(
        (await averageRowBytes<NodeSizeRow>(
          "storage_nodes",
          "key_id",
          "segment",
          (row) => namespaceBytes + 32 + 32 + textBytes(row.segment) + keyEntryBytes(namespaceBytes, 32),
        )) * nodesAhead,
      ) +
      Math.ceil(
        (await averageRowBytes<ArtifactSizeRow>(
          "storage_artifacts",
          "key_text",
          "key_text, owner_key, location",
          (row) =>
            namespaceBytes +
            textBytes(row.key_text) +
            textBytes(row.owner_key) +
            textBytes(row.location) +
            keyEntryBytes(namespaceBytes, textBytes(row.key_text)),
        )) * artifactsAhead,
      )
    if (!staged) return
    const missing = staged - Number(shell?.freeBytes ?? 0)
    if (missing <= 0) return
    const disk = await fs.statfs(path.dirname(filename), { bigint: true })
    const available = disk.bavail * disk.bsize
    if (available >= BigInt(missing)) return
    throw new StorageIntegrityError(
      `The format 3 rewrite needs ${missing} bytes (${gib(missing)} GiB) of free space to hold its replacement records, nodes and artifact tables beside the live ones, but the volume holding the store has ${available} bytes (${gib(available)} GiB) available; free space and resume`,
    )
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
    await store.maintainDdlTransaction(
      [
        { statement: `DROP TABLE IF EXISTS ${nodesTable}` },
        { statement: nodesTableDdl("sqlite", nodesTable) },
        { statement: "DROP TABLE storage_nodes" },
        { statement: `ALTER TABLE ${nodesTable} RENAME TO storage_nodes` },
        { statement: STORAGE_NODES_PARENT_INDEX },
      ],
      "create-index",
    )
    await deriveNodes(store, "storage_nodes", "", () => {})
  }

  async function createStateTable(store: TransactionalStore) {
    await store.maintainDdlTransaction([
      { statement: `CREATE TABLE IF NOT EXISTS ${stateTable} (namespace TEXT PRIMARY KEY, state TEXT NOT NULL)` },
    ])
  }

  async function readState(store: TransactionalStore): Promise<State | undefined> {
    return StorageFormatV3State.read(store)
  }

  async function writeState(store: TransactionalStore, state: State) {
    await store.transaction(async (tx) => {
      await StorageFormatV3State.assertUnchanged(tx.raw, store.options.namespace)
      await StorageFormatV3State.write(tx.raw, store.options.namespace, state)
    })
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
      UpgradeWork.signal()?.throwIfAborted()
      const rows = await store.transaction(async (tx) => {
        await StorageFormatV3State.assertUnchanged(tx.raw, store.options.namespace)
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
        await StorageFormatV3State.write(tx.raw, store.options.namespace, {
          ...state,
          recordsCursor: page.at(-1)!.key_id,
        })
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
    if (!state.nodesCursor)
      await store.maintainDdlTransaction([
        { statement: `DROP TABLE IF EXISTS ${nodesTable}` },
        { statement: nodesTableDdl("sqlite", nodesTable) },
      ])
    await deriveNodes(store, nodesTable, state.nodesCursor, (derived) => progress?.(derived, 0, 2), state)
    state = { ...state, phase: "artifacts", nodesCursor: "" }
    await writeState(store, state)
    return state
  }

  /**
   * Creates the artifact replacement table when it does not exist, and reports
   * the `pack` layout it has.
   *
   * Format 3 derives `pack` from the `location` JSON, which is what makes the
   * column free, but a generated column is an engine feature the rewrite cannot
   * assume: an engine built without the JSON functions rejects the declaration,
   * and one that accepts it can still refuse to index it. The layout is therefore
   * verified here, before a single row is copied, and the run stages a physical
   * `pack TEXT NOT NULL` column when the engine cannot supply a generated one.
   * The fallback keeps the `pack` column name and the `storage_artifacts_pack`
   * index, so the two layouts are indistinguishable to every reader; they differ
   * only in whether a writer may name the column, which `writeArtifacts` decides
   * from this same table shape.
   *
   * The table is created once and kept. Like the records copy, this phase resumes
   * from a durable cursor, so recreating the table on a resumed run would discard
   * every row below that cursor -- the copy would resume past rows the emptied
   * table no longer holds, and the swap would install an artifact table missing
   * them. Keeping it is also what records the layout without a second copy of the
   * decision: a resumed run reads the shape of the very table it is about to
   * rename, so the staging table is itself the authority on the layout the swap
   * installs.
   */
  async function prepareArtifactsTable(
    store: TransactionalStore,
    supportsGeneratedPack: () => Promise<boolean>,
  ): Promise<ArtifactPackLayout> {
    const [existing] = await store.snapshot(
      (tx) =>
        tx.raw.query<{ tables: bigint | number }>(
          "SELECT COUNT(*) AS tables FROM sqlite_master WHERE type = 'table' AND name = ?",
          [artifactsTable],
        ),
      { singleStatement: true },
    )
    // A resumed run adopts the layout its own earlier attempt staged rather than
    // asking the engine again: the rows already in that table were written for the
    // shape it has, and staging the other shape would leave a table whose column
    // set disagrees with its contents.
    if (Number(existing?.tables ?? 0) > 0)
      return store.snapshot((tx) => artifactPackLayout(tx.raw, artifactsTable), { singleStatement: true })
    const layout: ArtifactPackLayout = (await supportsGeneratedPack()) ? "generated" : "physical"
    if (layout === "physical") {
      // The rewrite is still correct and the store fully readable, but this
      // namespace now differs from every store rewritten by an engine that
      // supports the column, so the difference is reported rather than left to be
      // discovered from the schema.
      log.warn("format 3 rewrite staged a physical artifact pack column", {
        namespace: store.options.namespace,
      })
      ObservabilityIssues.raise({
        code: "STORAGE_FORMAT_V3_ARTIFACT_PACK_PHYSICAL",
        severity: "warning",
        module: "storage",
        title: "Format 3 rewrite fell back to a physical artifact pack column",
        message:
          "The SQLite engine could not accept or index the generated `pack` column the format 3 artifact layout derives from `location`, so the rewrite staged the physical column instead. The replacement keeps the `pack` column name, the `storage_artifacts_pack` index and every reader, and the rewrite completes normally; only the storage the duplicated pack value costs is not returned.",
        recommendation:
          "Confirm the runtime is using a SQLite build with the JSON functions enabled. The layout is decided when a namespace is rewritten and is not revisited afterwards, so an affected store keeps the physical column until it is rewritten again from a backup under a supported engine.",
        evidence: { table: artifactsTable, probe: artifactsProbeTable },
      })
    }
    await store.maintainDdlTransaction([
      { statement: `DROP TABLE IF EXISTS ${artifactsTable}` },
      { statement: artifactsTableDdl("sqlite", artifactsTable, layout) },
    ])
    return layout
  }

  /**
   * Whether this engine both accepts and can index a generated `pack` column.
   *
   * The question is asked of a scratch table carrying the format 3 artifact DDL
   * and the index the swap will build on the replacement, so what is verified is
   * the shape the rewrite commits rather than a stand-in for it. Both steps run
   * on an empty table and cost nothing that scales with the store.
   *
   * The engine's own catalog answers through `pragma_table_xinfo` and
   * `pragma_index_xinfo` rather than through a planned query: `EXPLAIN QUERY PLAN`
   * holds a statement open on the table it plans, and SQLite then refuses the
   * `DROP INDEX` and `ALTER TABLE` the swap performs next.
   */
  async function supportsGeneratedArtifacts(store: TransactionalStore): Promise<boolean> {
    try {
      await store.maintainDdlTransaction([
        { statement: `DROP TABLE IF EXISTS ${artifactsProbeTable}` },
        { statement: artifactsTableDdl("sqlite", artifactsProbeTable, "generated") },
        { statement: `CREATE INDEX ${artifactsProbeIndex} ON ${artifactsProbeTable}(namespace, pack)` },
      ])
    } catch (error) {
      // A rejected declaration or a rejected index is the unsupported case, not a
      // failure of the rewrite: the caller stages the physical layout instead. The
      // engine's own message is recorded because it is the only thing that
      // separates "this engine has no JSON functions" from an unrelated refusal,
      // and the fallback is otherwise indistinguishable from a normal rewrite.
      log.warn("format 3 artifact pack probe was rejected", {
        namespace: store.options.namespace,
        reason: error instanceof Error ? error.message : String(error),
      })
      return false
    }
    const [probe] = await store.snapshot(
      (tx) =>
        tx.raw.query<{ engineDerived: bigint | number | null; indexEntries: bigint | number }>(
          `SELECT (SELECT hidden FROM pragma_table_xinfo(?) WHERE name = 'pack') AS engineDerived, (SELECT COUNT(*) FROM pragma_index_xinfo(?) WHERE name = 'pack' AND "key" = 1) AS indexEntries`,
          [artifactsProbeTable, artifactsProbeIndex],
        ),
      { singleStatement: true },
    )
    await store.maintainDdlTransaction([{ statement: `DROP TABLE IF EXISTS ${artifactsProbeTable}` }])
    // `hidden` is 2 for a `VIRTUAL` generated column and 3 for a `STORED` one; a
    // plain column reports 0, and a table without the column reports nothing. The
    // index must also carry a key entry for `pack`, which is the other half of
    // what "can index it" means.
    return Number(probe?.engineDerived ?? 0) >= 2 && Number(probe?.indexEntries ?? 0) > 0
  }

  async function copyArtifacts(
    store: TransactionalStore,
    state: State,
    progress: ((current: number, total: number, phase: number) => void) | undefined,
    supportsGeneratedPack: () => Promise<boolean>,
  ): Promise<State> {
    if (state.phase !== "artifacts") return state
    progress?.(0, 0, 3)
    const generated = (await prepareArtifactsTable(store, supportsGeneratedPack)) === "generated"
    // The two layouts differ in exactly one thing: whether this writer supplies
    // `pack`. Naming an engine-derived column is an error and omitting a real
    // `NOT NULL` one is too, so the statement follows the staged shape.
    const columns = generated
      ? "(namespace, key_text, owner_key, location)"
      : "(namespace, key_text, owner_key, location, pack)"
    const placeholder = generated ? "(?, ?, ?, ?)" : "(?, ?, ?, ?, ?)"
    let cursor = state.artifactsCursor
    let copied = 0
    for (;;) {
      UpgradeWork.signal()?.throwIfAborted()
      const rows = await store.transaction(async (tx) => {
        await StorageFormatV3State.assertUnchanged(tx.raw, store.options.namespace)
        const page = await tx.raw.query<{ key_text: string; owner_key: string; location: string }>(
          "SELECT key_text, owner_key, location FROM storage_artifacts WHERE namespace = ? AND key_text > ? ORDER BY key_text LIMIT ?",
          [store.options.namespace, cursor, BATCH],
        )
        if (!page.length) return []
        const values: SqlValue[] = []
        for (const row of page) {
          values.push(store.options.namespace, row.key_text, row.owner_key, row.location)
          // The fallback supplies the physical column from the row's own location
          // rather than through a SQL JSON function, because an engine without
          // those functions is exactly the case the fallback exists for.
          if (!generated) values.push(packFromLocation(row.location))
        }
        await tx.raw.query(
          `INSERT OR REPLACE INTO ${artifactsTable}${columns} VALUES ${page.map(() => placeholder).join(",")}`,
          values,
        )
        await StorageFormatV3State.write(tx.raw, store.options.namespace, {
          ...state,
          artifactsCursor: page.at(-1)!.key_text,
        })
        return page
      })
      if (!rows.length) break
      copied += rows.length
      cursor = rows.at(-1)!.key_text
      state = { ...state, artifactsCursor: cursor }
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
    checkpoint?: State,
  ): Promise<void> {
    let cursor = startCursor
    let derived = 0
    for (;;) {
      UpgradeWork.signal()?.throwIfAborted()
      const rows = await store.transaction(async (tx) => {
        if (checkpoint) await StorageFormatV3State.assertUnchanged(tx.raw, store.options.namespace)
        const page = await tx.raw.query<{ key_id: string; key_text: string }>(
          "SELECT key_id, key_text FROM storage_records WHERE namespace = ? AND body IS NOT NULL AND key_id > ? ORDER BY key_id LIMIT ?",
          [store.options.namespace, cursor, BATCH],
        )
        if (!page.length) return []
        await writeNodes(store, tx.raw, table, page)
        if (checkpoint)
          await StorageFormatV3State.write(tx.raw, store.options.namespace, {
            ...checkpoint,
            nodesCursor: page.at(-1)!.key_id,
          })
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
    UpgradeWork.signal()?.throwIfAborted()
    progress?.(0, 0, 4)
    const namespace = store.options.namespace
    // Read before the swap's own transaction: the shape of the table being
    // renamed is the only record of which layout this run staged, and reading it
    // here is what lets a run resumed at the swap install the same one.
    const artifactPack = await store.snapshot((tx) => artifactPackLayout(tx.raw, artifactsTable), {
      singleStatement: true,
    })
    const next: State = { ...state, phase: "reclaim" }
    await store.maintainDdlTransaction(
      [
        ...StorageFormatV3State.fences(false),
        { statement: "DROP TABLE storage_records" },
        { statement: `ALTER TABLE ${recordsTable} RENAME TO storage_records` },
        { statement: "DROP TABLE storage_nodes" },
        { statement: `ALTER TABLE ${nodesTable} RENAME TO storage_nodes` },
        { statement: "DROP TABLE storage_artifacts" },
        { statement: `ALTER TABLE ${artifactsTable} RENAME TO storage_artifacts` },
        // `DROP TABLE` took every index with the dropped tables, so these rebuilds
        // are the only ones. Each build reads a whole table, so the bundle is
        // announced as an index build on the maintenance lifecycle; that is what
        // gives it the ceiling budget rather than a chunk budget a store this size
        // cannot meet.
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
        {
          statement: "UPDATE storage_namespaces SET version = 3 WHERE namespace = ?",
          values: [namespace] as SqlValue[],
        },
      ],
      "create-index",
      (connection) => StorageFormatV3State.assertUnchanged(connection, namespace),
    )
    // Reads declare a single-statement contract and cannot re-read the format per
    // statement, so the store adopts the byte encoding and the artifact layout in
    // the process that performed the swap.
    store.adoptFormatV3(artifactPack)
    progress?.(1, 1, 4)
    return next
  }
}
