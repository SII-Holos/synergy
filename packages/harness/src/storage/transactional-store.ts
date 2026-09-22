import type { StorageEntry } from "./portable"
import { createHash, randomUUID } from "node:crypto"
import {
  NotFoundError,
  SessionPreparingError,
  StorageClosedError,
  StorageConflictError,
  StorageIntegrityError,
  StorageOwnershipError,
  StorageUnavailableError,
} from "./errors"
import { ArtifactLocation } from "./artifact-location"
import { RecordCodec, type BodyContainer, type RecordBody } from "./record-codec"
import { measureStorageOperation } from "./measure"
import { StorageQueue, type StorageQueueOptions } from "./queue"
import { observeStorageProgress } from "./progress"
import type { StorageMaintenanceOperation } from "@ericsanchezok/synergy-util/runtime-startup"
import { StoragePath } from "./path"
import { SqliteDriver } from "./sqlite-driver"
import { PostgresDriver } from "./postgres-driver"
import { sqlParameterBytes } from "./sql-contract"
import { Identifier } from "../id/id"
import type {
  SqlConnection,
  SqlDriver,
  SqlRow,
  SqlValue,
  SqliteMaintenanceRequest,
  SqliteMaintenanceResult,
  StoreOptions,
} from "./sql-contract"

export type { StoreOptions } from "./sql-contract"
export interface StoredEvent {
  id: string
  scopeID: string
  type: string
  payload: unknown
}
export interface TransactionOptions extends StorageQueueOptions {
  operationID?: string
  requestHash?: string
}
export interface PruneLimits {
  records: number
  nodes: number
  artifacts: number
}
export type PruneDeferral = "records" | "nodes" | "artifacts" | "active" | "recent"
export interface RecordQuery {
  kind?: string
  scopeID?: string
  sessionID?: string
  messageID?: string
  after?: string[]
  limit?: number
  descending?: boolean
}
export interface StoredRecord<T = unknown> {
  key: string[]
  value: T
  revision: bigint
}

type RecordRow = SqlRow & { key_text: string; body: string | Uint8Array | null; revision: bigint | number | string }

function keyDigest(key: readonly string[]) {
  if (!Array.isArray(key) || key.some((value) => typeof value !== "string" || value.length === 0))
    throw new StorageIntegrityError("A storage key must contain nonempty string segments")
  return createHash("sha256").update(JSON.stringify(key)).digest()
}

/** The hex digest: the identity a JavaScript `Map` or `Set` keys a record by. */
function keyID(key: readonly string[]) {
  return keyDigest(key).toString("hex")
}

/** The raw digest: the value a format 3 key column stores. */
export function keyBytes(key: readonly string[]): Uint8Array {
  return new Uint8Array(keyDigest(key))
}

/** A logical key as the value its key columns are bound with. */
function keyColumnValue(keys: KeyEncoding, key: readonly string[]): SqlValue {
  return keys === "bytes" ? keyBytes(key) : keyID(key)
}

/**
 * How this namespace binds a logical key to its key column.
 *
 * `bytes` is format 3 and is what a SQLite namespace uses once its records
 * table has been rewritten; `hex` is format 2 and is what a PostgreSQL
 * namespace always uses, because one `text` column cannot also hold a `bytea`
 * value. The choice follows the namespace's recorded format, never the backend
 * alone: a namespace whose version still says 2 holds hex rows, and binding
 * bytes against them would silently address nothing.
 */
export type KeyEncoding = "hex" | "bytes"

function keyParameter(keys: KeyEncoding, key: readonly string[]) {
  return keys === "bytes" ? keyBytes(key) : keyID(key)
}

/** The same encoding for a caller that already holds the hex identity. */
function keyHexParameter(keys: KeyEncoding, hex: string) {
  return keys === "bytes" ? new Uint8Array(Buffer.from(hex, "hex")) : hex
}

/** Normalizes a key column read back from either backend to hex identity. */
function keyHex(value: SqlValue) {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex")
  throw new StorageIntegrityError("A storage key column holds an unsupported value")
}

/** The container a body column may hold, from the namespace's recorded key encoding. */
function bodyContainer(keys: KeyEncoding): BodyContainer {
  return keys === "bytes" ? "frame" : "text"
}

/** Normalizes a body column read back from either backend to the codec's input. */
function recordBody(value: SqlValue): RecordBody {
  if (typeof value === "string" || value instanceof Uint8Array) return value
  throw new StorageIntegrityError("A storage body column holds an unsupported value")
}

function metadata(key: string[]) {
  if (key[0] === "sessions") {
    const message = key[3] === "messages"
    return {
      kind: message
        ? key[5] === "parts"
          ? "part"
          : "message"
        : key[3] === "info"
          ? "session"
          : key[3] === "inbox"
            ? "inbox"
            : (key[3] ?? "session-record"),
      scope: key[1] ?? "",
      session: key[2] ?? "",
      message: message ? (key[4] ?? "") : "",
      order: key.at(-1) === "info" ? key.at(-2)! : key.at(-1)!,
    }
  }
  return {
    kind: key[0],
    scope: ["projects", "compat_catalog"].includes(key[0]) ? (key[1] ?? "") : "",
    session: "",
    message: "",
    order: key[0] === "compat_catalog" ? key[2]! : key.at(-1)!,
  }
}

/**
 * Serves retention's owner enumeration.
 *
 * The key carries `scope_id`, `session_id` and `updated` after the `kind` prefix,
 * which lets `evidenceOwners` aggregate rows in owner order without a
 * temporary b-tree. Counting still visits each live rollout index entry.
 * `key_text` is deliberately absent: selecting it would force a table walk per
 * row and the index would stop paying for itself. The partial predicate keeps
 * tombstoned rows out of a write-maintained index.
 *
 * The open path creates it from `schema` and the owning migration re-runs it for
 * stores created before the index existed, so both share this one definition.
 */
export const STORAGE_RECORDS_OWNER_INDEX =
  "CREATE INDEX IF NOT EXISTS storage_records_owner ON storage_records(namespace, kind, scope_id, session_id, updated) WHERE body IS NOT NULL"

// How many records one prune statement removes. Retention prunes whole
// subtrees, and a subtree can hold millions of rows: issuing that as one
// statement is what let a single pass occupy the worker's event loop past the
// ceiling. Each round is its own statement the caller commits, so the work is
// interruptible between rounds and no single statement grows with subtree size.
const PRUNE_CHUNK = 4096

// Format 3 stores a logical key as the raw 32-byte digest in a column declared
// `BLOB`. That declaration is deliberate: a `BLOB` column has no affinity, so a
// byte string written by this format and the hex text string an older format
// wrote occupy the same column and both stay readable. The rewrite can therefore
// run in bounded batches over a live table, and a stored value never needs a
// second column or an in-place type conversion.
//
// PostgreSQL cannot mix `text` and `bytea` in one column, so a PostgreSQL
// namespace keeps the format 2 layout and hex encoding, and the format 3
// rewrite is a no-op there. The `POSTGRES_*` definitions below are that layout,
// not a compatibility path.
/**
 * The format 3 artifact layout: `pack` is derived from the `location` JSON by
 * the engine, so a writer must never name it.
 */
const generatedArtifactsColumns =
  "namespace TEXT NOT NULL, key_text TEXT NOT NULL, owner_key TEXT NOT NULL, location TEXT NOT NULL, pack TEXT GENERATED ALWAYS AS (json_extract(location, '$.pack')) VIRTUAL, PRIMARY KEY(namespace, key_text)"
const sqliteNodesColumns =
  "namespace TEXT NOT NULL, key_id BLOB NOT NULL, parent_id BLOB NOT NULL, segment TEXT NOT NULL, PRIMARY KEY(namespace, key_id)"
const sqliteRecordsColumns =
  "namespace TEXT NOT NULL, key_id BLOB NOT NULL, key_text TEXT NOT NULL, body BLOB, revision BIGINT NOT NULL, kind TEXT NOT NULL, scope_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, order_key TEXT NOT NULL, updated BIGINT NOT NULL, PRIMARY KEY(namespace, key_id)"
/**
 * The physical artifact layout: `pack` is a real column the writer supplies.
 * PostgreSQL always keeps it, because it has no `json_extract`, and a SQLite
 * namespace falls back to it when its engine cannot accept or index a generated
 * `pack` -- see `StorageFormatV3Migration`. The column name, the
 * `storage_artifacts_pack` index and every reader are the same in both layouts.
 */
const physicalArtifactsColumns =
  "namespace TEXT NOT NULL, key_text TEXT NOT NULL, owner_key TEXT NOT NULL, location TEXT NOT NULL, pack TEXT NOT NULL, PRIMARY KEY(namespace, key_text)"
const postgresNodesColumns =
  "namespace TEXT NOT NULL, key_id TEXT NOT NULL, parent_id TEXT NOT NULL, key_text TEXT NOT NULL, segment TEXT NOT NULL, PRIMARY KEY(namespace, key_id)"
const postgresRecordsColumns =
  "namespace TEXT NOT NULL, key_id TEXT NOT NULL, key_text TEXT NOT NULL, body TEXT, revision BIGINT NOT NULL, kind TEXT NOT NULL, scope_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, order_key TEXT NOT NULL, updated BIGINT NOT NULL, PRIMARY KEY(namespace, key_id)"

export type StorageBackend = "sqlite" | "postgres"

/**
 * How a namespace stores `storage_artifacts.pack`.
 *
 * `generated` is the format 3 column the engine derives from `location`, which a
 * writer must omit; `physical` is the format 2 column a writer supplies. The
 * choice decides only that: both keep the `pack` column name and the
 * `storage_artifacts_pack` index, and every reader reads `pack` either way. It
 * is read from the table rather than derived from the recorded format, because a
 * format 3 namespace takes the physical column when its SQLite engine cannot
 * accept or index a generated one.
 */
export type ArtifactPackLayout = "generated" | "physical"

/**
 * The artifact table DDL for a backend and layout.
 *
 * The default is the layout a namespace is born with: format 3 on SQLite, and
 * the physical column PostgreSQL -- and a SQLite fallback -- keep. `IF NOT
 * EXISTS` leaves an existing table alone, so a fallback store keeps the layout
 * the rewrite chose for it.
 */
export function artifactsTableDdl(
  backend: StorageBackend,
  name: string,
  packLayout: ArtifactPackLayout = backend === "sqlite" ? "generated" : "physical",
) {
  const layout = backend === "sqlite" ? packLayout : "physical"
  return `CREATE TABLE IF NOT EXISTS ${name} (${layout === "generated" ? generatedArtifactsColumns : physicalArtifactsColumns})`
}

/**
 * How `table` stores its `pack` column, read from the table itself.
 *
 * A pragma is the authority: the layout of a format 3 namespace depends on what
 * its engine supported when the rewrite staged it, so it can be neither assumed
 * from the recorded format nor held in a separate record that would have to stay
 * in step. `hidden` is 2 for a `VIRTUAL` generated column and 3 for a `STORED`
 * one; both are engine-derived and must stay out of an `INSERT`. A table without
 * the column, or a backend that has no generated columns, reports `physical`.
 */
export async function artifactPackLayout(connection: SqlConnection, table: string): Promise<ArtifactPackLayout> {
  const [row] = await connection.query<{ hidden: bigint | number }>(
    "SELECT hidden FROM pragma_table_xinfo(?) WHERE name = 'pack'",
    [table],
  )
  return row && Number(row.hidden) >= 2 ? "generated" : "physical"
}

export function nodesTableDdl(backend: StorageBackend, name: string) {
  return `CREATE TABLE IF NOT EXISTS ${name} (${backend === "sqlite" ? sqliteNodesColumns : postgresNodesColumns})`
}

export function recordsTableDdl(backend: StorageBackend, name: string) {
  return `CREATE TABLE IF NOT EXISTS ${name} (${backend === "sqlite" ? sqliteRecordsColumns : postgresRecordsColumns})`
}

/**
 * Every secondary index on `storage_records`, in dependency order.
 *
 * The definition is shared rather than repeated because the format 3 rewrite
 * drops and renames the table, and `DROP TABLE` takes its indexes with it: the
 * rewrite must recreate exactly this set in its swap transaction, and the open
 * path must create the same set on a fresh store. One definition is what keeps
 * the two from drifting.
 */
export const storageRecordsIndexes = (backend: StorageBackend) => [
  "CREATE INDEX IF NOT EXISTS storage_records_session ON storage_records(namespace, session_id, kind, order_key, key_id)",
  // Rollout rows carry an empty `message_id`, which was paying for a key entry
  // in every one of them; the predicate keeps tombstoned and ownerless rows out
  // of the index without changing which rows match a messageID query.
  backend === "sqlite"
    ? "CREATE INDEX IF NOT EXISTS storage_records_message ON storage_records(namespace, message_id, kind, order_key, key_id) WHERE message_id <> ''"
    : "CREATE INDEX IF NOT EXISTS storage_records_message ON storage_records(namespace, message_id, kind, order_key, key_id)",
  "CREATE INDEX IF NOT EXISTS storage_records_kind ON storage_records(namespace, kind, order_key, key_id)",
  STORAGE_RECORDS_OWNER_INDEX,
]

export const STORAGE_NODES_PARENT_INDEX =
  "CREATE INDEX IF NOT EXISTS storage_nodes_parent ON storage_nodes(namespace, parent_id)"

export const storageArtifactsIndexes = [
  "CREATE INDEX IF NOT EXISTS storage_artifacts_owner ON storage_artifacts(namespace, owner_key)",
  "CREATE INDEX IF NOT EXISTS storage_artifacts_pack ON storage_artifacts(namespace, pack)",
]

const schemaFor = (backend: StorageBackend) => [
  "CREATE TABLE IF NOT EXISTS storage_artifact_gc (namespace TEXT NOT NULL, pack TEXT NOT NULL, PRIMARY KEY(namespace, pack))",
  artifactsTableDdl(backend, "storage_artifacts"),
  ...storageArtifactsIndexes,
  "CREATE TABLE IF NOT EXISTS storage_namespaces (namespace TEXT PRIMARY KEY, version INTEGER NOT NULL, owner TEXT NOT NULL, state TEXT NOT NULL, next_event BIGINT NOT NULL DEFAULT 0)",
  nodesTableDdl(backend, "storage_nodes"),
  STORAGE_NODES_PARENT_INDEX,
  recordsTableDdl(backend, "storage_records"),
  ...storageRecordsIndexes(backend),
  "CREATE TABLE IF NOT EXISTS storage_receipts (namespace TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL, created BIGINT NOT NULL, PRIMARY KEY(namespace, operation_id))",
  "CREATE TABLE IF NOT EXISTS storage_events (namespace TEXT NOT NULL, id TEXT NOT NULL, scope_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, position BIGINT NOT NULL, PRIMARY KEY(namespace, id))",
  "CREATE INDEX IF NOT EXISTS storage_events_pending ON storage_events(namespace, position)",
]

export class StoreTransaction {
  private publishedOnly = false

  restrictToPublishedOwners() {
    this.publishedOnly = this.admission.pending
  }

  private visibility(alias = "storage_records") {
    return this.publishedOnly
      ? ` AND NOT EXISTS (SELECT 1 FROM storage_records pending WHERE pending.namespace = ${alias}.namespace AND pending.kind = 'compat_pending' AND pending.order_key = ${alias}.session_id AND pending.body IS NOT NULL)`
      : ""
  }

  private async assertAdmitted(keys: string[][], tree = false) {
    if (!this.publishedOnly) return
    const owners = [...new Set(keys.filter((key) => key[0] === "sessions" && key.length >= 3).map((key) => key[2]))]
    const broad = tree && keys.some((key) => !key.length || (key[0] === "sessions" && key.length < 3))
    if (!owners.length && !broad) return
    for (let offset = 0; broad || offset < owners.length; offset += 128) {
      const batch = owners.slice(offset, offset + 128)
      const [pending] = await this.connection.query(
        `SELECT order_key FROM storage_records WHERE namespace = ? AND kind = 'compat_pending' AND body IS NOT NULL${broad ? "" : ` AND order_key IN (${batch.map(() => "?").join(",")})`} LIMIT 1`,
        [this.namespace, ...(broad ? [] : batch)],
      )
      if (pending)
        throw new SessionPreparingError({
          sessionID: String(pending.order_key),
          message: "Historical Session preparation must finish before reading or changing its records",
        })
      if (broad) break
    }
  }

  private active = true
  private failure?: unknown
  private readonly connection: SqlConnection
  /**
   * The container a body may be written in.
   *
   * It follows the same recorded format as the key encoding, because a byte frame
   * is only storable where the body column is a blob -- the format 3 layout. A
   * `TEXT` column renders those bytes as hex text, which no reader accepts.
   * Deriving it here rather than storing it separately keeps the two from
   * disagreeing, and `adoptFormatV3` therefore flips both at once.
   */
  private get bodies(): BodyContainer {
    return bodyContainer(this.keys)
  }

  constructor(
    connection: SqlConnection,
    readonly namespace: string,
    private readonly readonly = false,
    private readonly keys: KeyEncoding = "bytes",
    private readonly backend: StorageBackend = "sqlite",
    private readonly artifactPack: ArtifactPackLayout = keys === "bytes" ? "generated" : "physical",
    private readonly admission = { pending: true },
  ) {
    this.connection = {
      query: async <Row extends SqlRow = SqlRow>(statement: string, values?: SqlValue[]) => {
        this.check()
        try {
          return await connection.query<Row>(statement, values)
        } catch (error) {
          this.failure = error
          throw error
        }
      },
    }
  }

  assertHealthy() {
    if (this.failure) throw this.failure
  }

  finish() {
    this.active = false
  }

  /**
   * The transaction's connection.
   *
   * Migration and maintenance paths issue SQL the typed read surface does not
   * express -- keyset copies, table rebuilds, prefix reconstruction -- and that
   * SQL has to run inside the same transaction and share its failure state, so
   * a poisoned transaction cannot be left half-applied.
   */
  get raw(): SqlConnection {
    this.check()
    return this.connection
  }

  private check(write = false) {
    if (!this.active) throw new StorageClosedError()
    this.assertHealthy()
    if (write && this.readonly) throw new StorageConflictError("Cannot write from a read-only snapshot")
  }

  private async row(key: string[]) {
    this.check()
    await this.assertAdmitted([key])
    const [row] = await this.connection.query<RecordRow>(
      "SELECT key_text, body, revision FROM storage_records WHERE namespace = ? AND key_id = ?",
      [this.namespace, keyParameter(this.keys, key)],
    )
    if (row && row.key_text !== JSON.stringify(key)) throw new StorageIntegrityError("Logical key identity collision")
    return row
  }

  async versioned<T = unknown>(key: string[]): Promise<StoredRecord<T>> {
    const row = await this.row(key)
    if (!row || row.body === null) throw new NotFoundError({ message: "Storage record does not exist" })
    return { key, value: RecordCodec.decode<T>(row.body), revision: BigInt(row.revision) }
  }

  async read<T = unknown>(key: string[]): Promise<T> {
    return (await this.versioned<T>(key)).value
  }

  async readMany<T = unknown>(keys: string[][]): Promise<(T | undefined)[]> {
    this.check()
    await this.assertAdmitted(keys)
    const result: (T | undefined)[] = []
    for (let offset = 0; offset < keys.length; offset += 128) {
      const batch = keys.slice(offset, offset + 128)
      const rows = await this.connection.query<RecordRow & { key_id: SqlValue }>(
        `SELECT key_id, key_text, body, revision FROM storage_records WHERE namespace = ? AND key_id IN (${batch.map(() => "?").join(",")})`,
        [this.namespace, ...batch.map((key) => keyParameter(this.keys, key))],
      )
      const index = new Map(rows.map((row) => [keyHex(row.key_id), row]))
      for (const key of batch) {
        const row = index.get(keyID(key))
        if (row && row.key_text !== JSON.stringify(key))
          throw new StorageIntegrityError("Logical key identity collision")
        result.push(row?.body ? RecordCodec.decode<T>(row.body) : undefined)
      }
    }
    return result
  }

  async write<T>(key: string[], value: T, options: { expectedRevision?: bigint } = {}): Promise<void> {
    this.check(true)
    await this.assertAdmitted([key])
    if (key[0] === "compat_pending") this.admission.pending = true
    if (key[0] === "sessions" && key.length >= 4) await this.assertNotDeleted([...key.slice(0, 3), "info"])
    await this.put(key, value, options)
  }

  async writeMany(entries: Array<{ key: string[]; value: unknown }>): Promise<void> {
    this.check(true)
    await this.assertAdmitted(entries.map((entry) => entry.key))
    if (entries.some((entry) => entry.key[0] === "compat_pending")) this.admission.pending = true
    const unique = new Set<string>()
    const prepared = entries.map(({ key, value }) => {
      if (!key.length) throw new StorageIntegrityError("Cannot write the storage root")
      const id = keyID(key)
      if (unique.has(id)) throw new StorageIntegrityError("A bulk write must contain distinct logical keys")
      unique.add(id)
      const text = JSON.stringify(key)
      const body = RecordCodec.encode(value, this.bodies)
      const meta = metadata(key)
      const bytes = sqlParameterBytes([
        this.namespace,
        id,
        text,
        body,
        0n,
        meta.kind,
        meta.scope,
        meta.session,
        meta.message,
        meta.order,
        0,
      ])
      return { key, id, text, body, meta, bytes }
    })
    for (let offset = 0; offset < prepared.length; ) {
      let end = offset,
        bytes = 0
      while (end < prepared.length && end - offset < 64) {
        const size = prepared[end].bytes
        if (end > offset && bytes + size > 8 * 1024 * 1024) break
        bytes += size
        end++
      }
      const batch = prepared.slice(offset, end)
      offset = end
      const owners = new Map<string, string[]>()
      for (const { key } of batch)
        if (key[0] === "sessions" && key.length >= 4) {
          const owner = [...key.slice(0, 3), "info"]
          owners.set(keyID(owner), owner)
        }
      const identities = [...new Set([...batch.map((entry) => entry.id), ...owners.keys()])]
      const rows = await this.connection.query<RecordRow & { key_id: SqlValue }>(
        `SELECT key_id, key_text, body, revision FROM storage_records WHERE namespace = ? AND key_id IN (${identities.map(() => "?").join(",")})`,
        [this.namespace, ...identities.map((id) => keyHexParameter(this.keys, id))],
      )
      const previous = new Map(rows.map((row) => [keyHex(row.key_id), row]))
      for (const [id, key] of owners) {
        const row = previous.get(id)
        if (row && row.key_text !== JSON.stringify(key))
          throw new StorageIntegrityError("Logical key identity collision")
        if (row?.body === null) throw new StorageConflictError("A deleted record cannot be revived by a delayed writer")
      }
      // A namespace that has not been rewritten yet still has the format 2 node
      // table, whose `key_text` is NOT NULL. The row shape has to follow the
      // namespace's own layout, not this code version, or a write issued before
      // the rewrite runs would fail the constraint.
      const legacyNodes = this.keys === "hex"
      const nodes = new Map<string, SqlValue[]>()
      const values: SqlValue[] = []
      for (const entry of batch) {
        const before = previous.get(entry.id)
        if (before && before.key_text !== entry.text) throw new StorageIntegrityError("Logical key identity collision")
        for (let depth = 1; depth <= entry.key.length; depth++) {
          const prefix = entry.key.slice(0, depth)
          const id = keyID(prefix)
          nodes.set(
            id,
            legacyNodes
              ? [this.namespace, id, keyID(prefix.slice(0, -1)), JSON.stringify(prefix), prefix.at(-1)!]
              : [
                  this.namespace,
                  keyHexParameter(this.keys, id),
                  keyParameter(this.keys, prefix.slice(0, -1)),
                  prefix.at(-1)!,
                ],
          )
        }
        values.push(
          this.namespace,
          keyHexParameter(this.keys, entry.id),
          entry.text,
          entry.body,
          BigInt(before?.revision ?? 0) + 1n,
          entry.meta.kind,
          entry.meta.scope,
          entry.meta.session,
          entry.meta.message,
          entry.meta.order,
          Date.now(),
        )
      }
      const paths = [...nodes.values()]
      for (let index = 0; index < paths.length; index += 128) {
        const group = paths.slice(index, index + 128)
        await this.connection.query(
          legacyNodes
            ? `INSERT INTO storage_nodes(namespace, key_id, parent_id, key_text, segment) VALUES ${group.map(() => "(?, ?, ?, ?, ?)").join(",")} ON CONFLICT(namespace, key_id) DO NOTHING`
            : `INSERT INTO storage_nodes(namespace, key_id, parent_id, segment) VALUES ${group.map(() => "(?, ?, ?, ?)").join(",")} ON CONFLICT(namespace, key_id) DO NOTHING`,
          group.flat(),
        )
      }
      await this.connection.query(
        `INSERT INTO storage_records(namespace, key_id, key_text, body, revision, kind, scope_id, session_id, message_id, order_key, updated) VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",")} ON CONFLICT(namespace, key_id) DO UPDATE SET body = excluded.body, revision = excluded.revision, kind = excluded.kind, scope_id = excluded.scope_id, session_id = excluded.session_id, message_id = excluded.message_id, order_key = excluded.order_key, updated = excluded.updated`,
        values,
      )
    }
  }

  private async put<T>(key: string[], value: T, options: { expectedRevision?: bigint } = {}): Promise<void> {
    this.check(true)
    if (!key.length) throw new StorageIntegrityError("Cannot write the storage root")
    const previous = await this.row(key)
    const revision = previous ? BigInt(previous.revision) : 0n
    if (options.expectedRevision !== undefined && options.expectedRevision !== revision)
      throw new StorageConflictError("Storage revision changed")
    const legacyNodes = this.keys === "hex"
    const nodes: SqlValue[] = []
    for (let depth = 1; depth <= key.length; depth++) {
      const prefix = key.slice(0, depth)
      nodes.push(
        this.namespace,
        keyParameter(this.keys, prefix),
        keyParameter(this.keys, prefix.slice(0, -1)),
        ...(legacyNodes ? [JSON.stringify(prefix)] : []),
        prefix.at(-1)!,
      )
    }
    await this.connection.query(
      legacyNodes
        ? `INSERT INTO storage_nodes(namespace, key_id, parent_id, key_text, segment) VALUES ${key.map(() => "(?, ?, ?, ?, ?)").join(",")} ON CONFLICT(namespace, key_id) DO NOTHING`
        : `INSERT INTO storage_nodes(namespace, key_id, parent_id, segment) VALUES ${key.map(() => "(?, ?, ?, ?)").join(",")} ON CONFLICT(namespace, key_id) DO NOTHING`,
      nodes,
    )
    const meta = metadata(key)
    await this.connection.query(
      "INSERT INTO storage_records(namespace, key_id, key_text, body, revision, kind, scope_id, session_id, message_id, order_key, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(namespace, key_id) DO UPDATE SET body = excluded.body, revision = excluded.revision, kind = excluded.kind, scope_id = excluded.scope_id, session_id = excluded.session_id, message_id = excluded.message_id, order_key = excluded.order_key, updated = excluded.updated",
      [
        this.namespace,
        keyParameter(this.keys, key),
        JSON.stringify(key),
        RecordCodec.encode(value, this.bodies),
        revision + 1n,
        meta.kind,
        meta.scope,
        meta.session,
        meta.message,
        meta.order,
        Date.now(),
      ],
    )
  }

  async update<T>(key: string[], change: (value: T) => void): Promise<T> {
    this.check(true)
    const before = await this.versioned<T>(key)
    change(before.value)
    await this.write(key, before.value, { expectedRevision: before.revision })
    return before.value
  }

  async remove(key: string[]): Promise<void> {
    this.check(true)
    await this.assertAdmitted([key])
    await this.connection.query(
      "UPDATE storage_records SET body = NULL, revision = revision + 1, updated = ? WHERE namespace = ? AND key_id = ? AND body IS NOT NULL",
      [Date.now(), this.namespace, keyParameter(this.keys, key)],
    )
    // The tombstone stays; the node chain the removal emptied does not.
    await this.cleanDanglingNodes([key])
  }

  async removeMany(keys: string[][]): Promise<void> {
    this.check(true)
    await this.assertAdmitted(keys)
    for (let offset = 0; offset < keys.length; offset += 128) {
      const batch = keys.slice(offset, offset + 128)
      await this.connection.query(
        `UPDATE storage_records SET body = NULL, revision = revision + 1, updated = ? WHERE namespace = ? AND key_id IN (${batch.map(() => "?").join(",")}) AND body IS NOT NULL`,
        [Date.now(), this.namespace, ...batch.map((key) => keyParameter(this.keys, key))],
      )
      await this.cleanDanglingNodes(batch)
    }
  }

  // SQLite must drive recursion and record lookups from the frontier; otherwise
  // even an empty prefix can scan every record in the namespace.
  async scan(prefix: string[]): Promise<string[]> {
    this.check()
    const rows = await this.connection.query<SqlRow & { child: string }>(
      "SELECT child.segment AS child FROM storage_nodes child WHERE child.namespace = ? AND child.parent_id = ? AND EXISTS (WITH RECURSIVE tree(key_id) AS (SELECT child.key_id UNION ALL SELECT node.key_id FROM tree CROSS JOIN storage_nodes node WHERE node.namespace = ? AND node.parent_id = tree.key_id) SELECT 1 FROM tree CROSS JOIN storage_records record WHERE record.key_id = tree.key_id AND record.namespace = ? AND record.body IS NOT NULL" +
        this.visibility("record") +
        " LIMIT 1)",
      [this.namespace, keyParameter(this.keys, prefix), this.namespace, this.namespace],
    )
    return rows.map((row) => row.child).sort()
  }

  async list(prefix: string[]): Promise<string[][]> {
    this.check()
    const rows = await this.connection.query<SqlRow & { key_text: string }>(
      "WITH RECURSIVE tree(key_id) AS (SELECT key_id FROM storage_nodes WHERE namespace = ? AND parent_id = ? UNION ALL SELECT node.key_id FROM tree CROSS JOIN storage_nodes node WHERE node.namespace = ? AND node.parent_id = tree.key_id) SELECT record.key_text FROM tree CROSS JOIN storage_records record WHERE record.key_id = tree.key_id AND record.namespace = ? AND record.body IS NOT NULL" +
        this.visibility("record"),
      [this.namespace, keyParameter(this.keys, prefix), this.namespace, this.namespace],
    )
    return rows.map((row) => JSON.parse(row.key_text) as string[]).sort()
  }

  async removeTree(prefix: string[]): Promise<void> {
    this.check(true)
    await this.assertAdmitted([prefix], true)
    let artifactCondition = "namespace = ?"
    const artifactValues: SqlValue[] = [this.namespace]
    if (prefix.length) {
      const text = JSON.stringify(prefix)
      const like = (text.slice(0, -1) + ",").replace(/[!%_]/g, (value) => "!" + value) + "%"
      artifactCondition += " AND (key_text = ? OR key_text LIKE ? ESCAPE '!')"
      artifactValues.push(text, like)
      const ownerLength = ["sessions", "operations"].includes(prefix[0]) ? 3 : 1
      if (prefix.length >= ownerLength) {
        artifactCondition += " AND owner_key = ?"
        artifactValues.push(JSON.stringify(prefix.slice(0, ownerLength)))
      }
    }
    await this.connection.query(
      `INSERT INTO storage_artifact_gc(namespace, pack) SELECT namespace, pack FROM storage_artifacts WHERE ${artifactCondition} ON CONFLICT(namespace, pack) DO NOTHING`,
      artifactValues,
    )
    await this.connection.query(`DELETE FROM storage_artifacts WHERE ${artifactCondition}`, artifactValues)
    if (!prefix.length) {
      await this.connection.query(
        "UPDATE storage_records SET body = NULL, revision = revision + 1, updated = ? WHERE namespace = ? AND body IS NOT NULL",
        [Date.now(), this.namespace],
      )
      await this.cleanDanglingNodes([[]])
      return
    }
    await this.connection.query(
      "WITH RECURSIVE tree(key_id) AS (SELECT key_id FROM storage_nodes WHERE namespace = ? AND key_id = ? UNION ALL SELECT node.key_id FROM tree CROSS JOIN storage_nodes node WHERE node.namespace = ? AND node.parent_id = tree.key_id) UPDATE storage_records SET body = NULL, revision = revision + 1, updated = ? WHERE namespace = ? AND key_id IN (SELECT key_id FROM tree) AND body IS NOT NULL",
      [this.namespace, keyParameter(this.keys, prefix), this.namespace, Date.now(), this.namespace],
    )
    await this.cleanDanglingNodes([prefix])
  }

  // Provenance: docs/research/2026-09-22-interactive-storage-validation.md
  // Local adaptation: indexed addressed-key joins bound interference from unrelated historical nodes.
  // Every join is driven by addressed keys. A namespace-led OR/IN predicate
  // makes even deletion of a missing key scan the whole historical node table.
  private async cleanDanglingNodes(prefixes: string[][]): Promise<void> {
    const roots = new Map(prefixes.map((key) => [keyID(key), keyParameter(this.keys, key)]))
    if (!roots.size) return
    const ancestors = new Map<string, SqlValue>()
    for (const prefix of prefixes)
      for (let depth = 1; depth < prefix.length; depth++) {
        const key = prefix.slice(0, depth)
        ancestors.set(keyID(key), keyParameter(this.keys, key))
      }
    const ancestorRows = ancestors.size
      ? `, ancestors(key_id) AS (VALUES ${[...ancestors].map(() => "(?)").join(",")})`
      : ""
    for (;;) {
      const dropped = await this.connection.query<SqlRow>(
        `WITH RECURSIVE roots(key_id) AS (VALUES ${[...roots].map(() => "(?)").join(",")}),
         subtree(key_id) AS (
           SELECT node.key_id FROM roots CROSS JOIN storage_nodes node
            WHERE node.namespace = ? AND node.key_id = roots.key_id
           UNION
           SELECT node.key_id FROM roots CROSS JOIN storage_nodes node
            WHERE node.namespace = ? AND node.parent_id = roots.key_id
           UNION
           SELECT node.key_id FROM subtree CROSS JOIN storage_nodes node
            WHERE node.namespace = ? AND node.parent_id = subtree.key_id
         )${ancestorRows}, targets(key_id) AS (
           SELECT key_id FROM subtree${ancestors.size ? " UNION SELECT key_id FROM ancestors" : ""}
         ), candidate(key_id) AS (
           SELECT node.key_id FROM targets CROSS JOIN storage_nodes node
            WHERE node.namespace = ? AND node.key_id = targets.key_id
              AND NOT EXISTS (SELECT 1 FROM storage_records record WHERE record.namespace = ? AND record.key_id = node.key_id AND record.body IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM storage_nodes child WHERE child.namespace = ? AND child.parent_id = node.key_id)
            LIMIT ?
         )
         DELETE FROM storage_nodes WHERE namespace = ? AND key_id IN (SELECT key_id FROM candidate)
         RETURNING key_id`,
        [
          ...roots.values(),
          this.namespace,
          this.namespace,
          this.namespace,
          ...ancestors.values(),
          this.namespace,
          this.namespace,
          this.namespace,
          PRUNE_CHUNK,
          this.namespace,
        ],
      )
      if (!dropped.length) break
    }
  }

  /**
   * Physically removes a subtree. Retention uses this instead of `removeTree`
   * because a budgeted prune must return the bytes: `removeTree` leaves a
   * revision tombstone per record, which keeps the rows and their pages. Node
   * rows drop in dependency order so the logical index cannot keep a pruned
   * path reachable, and removed artifact references enqueue the same durable
   * collection intent ordinary deletion uses.
   */
  async pruneTree(prefix: string[], options: { maintenance?: boolean; signal?: AbortSignal } = {}): Promise<number> {
    this.check(true)
    await this.assertAdmitted([prefix], true)
    if (!prefix.length) throw new StorageIntegrityError("Cannot prune the storage root")
    const text = JSON.stringify(prefix)
    const like = (text.slice(0, -1) + ",").replace(/[!%_]/g, (value) => "!" + value) + "%"
    let artifactCondition = "namespace = ? AND (key_text = ? OR key_text LIKE ? ESCAPE '!')"
    const artifactValues: SqlValue[] = [this.namespace, text, like]
    const ownerLength = ["sessions", "operations"].includes(prefix[0]) ? 3 : 1
    if (prefix.length >= ownerLength) {
      artifactCondition += " AND owner_key = ?"
      artifactValues.push(JSON.stringify(prefix.slice(0, ownerLength)))
    }
    await this.connection.query(
      `INSERT INTO storage_artifact_gc(namespace, pack) SELECT namespace, pack FROM storage_artifacts WHERE ${artifactCondition} ON CONFLICT(namespace, pack) DO NOTHING`,
      artifactValues,
      options.maintenance ? { maintenance: "prune" } : undefined,
    )
    await this.connection.query(
      `DELETE FROM storage_artifacts WHERE ${artifactCondition}`,
      artifactValues,
      options.maintenance ? { maintenance: "prune" } : undefined,
    )
    const tree =
      "WITH RECURSIVE tree(key_id) AS MATERIALIZED (SELECT key_id FROM storage_nodes WHERE namespace = ? AND key_id = ? UNION ALL SELECT node.key_id FROM tree CROSS JOIN storage_nodes node WHERE node.namespace = ? AND node.parent_id = tree.key_id) "
    const values = [this.namespace, keyParameter(this.keys, prefix), this.namespace, this.namespace]
    const queryOptions = options.maintenance ? { maintenance: "prune" as const } : undefined
    options.signal?.throwIfAborted()
    const [count] = await this.connection.query(
      tree +
        "SELECT COUNT(*) AS count FROM tree CROSS JOIN storage_records record WHERE record.namespace = ? AND record.key_id = tree.key_id",
      values,
      queryOptions,
    )
    await this.connection.query(
      tree + "DELETE FROM storage_records WHERE namespace = ? AND key_id IN (SELECT key_id FROM tree)",
      values,
      queryOptions,
    )
    options.signal?.throwIfAborted()
    await this.connection.query(
      tree + "DELETE FROM storage_nodes WHERE namespace = ? AND key_id IN (SELECT key_id FROM tree)",
      values,
      queryOptions,
    )
    options.signal?.throwIfAborted()
    await this.cleanDanglingNodes([prefix])
    const removed = Number(count?.count ?? 0)
    return removed
  }

  async pruneDeferral(prefix: string[], limits: PruneLimits, cutoff: number): Promise<PruneDeferral | undefined> {
    this.check()
    const nodes = await this.connection.query<{ key_id: string | Uint8Array }>(
      "WITH RECURSIVE tree(key_id) AS (SELECT key_id FROM storage_nodes WHERE namespace = ? AND key_id = ? UNION ALL SELECT node.key_id FROM tree CROSS JOIN storage_nodes node WHERE node.namespace = ? AND node.parent_id = tree.key_id) SELECT key_id FROM tree LIMIT ?",
      [this.namespace, keyParameter(this.keys, prefix), this.namespace, limits.nodes + 1],
    )
    if (nodes.length > limits.nodes) return "nodes"
    let records = 0
    for (let offset = 0; offset < nodes.length; offset += 128) {
      const batch = nodes.slice(offset, offset + 128)
      const [row] = await this.connection.query<{ count: number | bigint; newest: number | bigint | null }>(
        `SELECT COUNT(*) AS count, MAX(updated) AS newest FROM storage_records WHERE namespace = ? AND key_id IN (${batch.map(() => "?").join(",")})`,
        [this.namespace, ...batch.map((node) => node.key_id)],
      )
      if (row?.newest !== null && Number(row?.newest) >= cutoff) return "recent"
      records += Number(row?.count ?? 0)
      if (records > limits.records) return "records"
    }
    const text = JSON.stringify(prefix)
    const like = (text.slice(0, -1) + ",").replace(/[!%_]/g, (value) => "!" + value) + "%"
    const ownerLength = ["sessions", "operations"].includes(prefix[0]) ? 3 : 1
    const artifacts = await this.connection.query(
      "SELECT key_text FROM storage_artifacts WHERE namespace = ? AND owner_key = ? AND (key_text = ? OR key_text LIKE ? ESCAPE '!') LIMIT ?",
      [this.namespace, JSON.stringify(prefix.slice(0, ownerLength)), text, like, limits.artifacts + 1],
    )
    if (artifacts.length > limits.artifacts) return "artifacts"
  }

  async query<T>(input: RecordQuery): Promise<StoredRecord<T>[]> {
    const rows = await this.queryRows<RecordRow>(input, "key_text, body, revision")
    return rows.map((row) => ({
      key: JSON.parse(row.key_text) as string[],
      value: RecordCodec.decode<T>(row.body!),
      revision: BigInt(row.revision),
    }))
  }

  async queryKeys(input: RecordQuery): Promise<string[][]> {
    const rows = await this.queryRows<{ key_text: string }>(input, "key_text")
    return rows.map((row) => JSON.parse(row.key_text) as string[])
  }

  private async queryRows<Row extends SqlRow>(input: RecordQuery, columns: string): Promise<Row[]> {
    this.check()
    const conditions = ["namespace = ?", "body IS NOT NULL"]
    const values: SqlValue[] = [this.namespace]
    for (const [field, value] of [
      ["kind", input.kind],
      ["scope_id", input.scopeID],
      ["session_id", input.sessionID],
      ["message_id", input.messageID],
    ] as const) {
      if (value === undefined) continue
      conditions.push(`${field} = ?`)
      values.push(value)
    }
    // `storage_records_message` is partial on a nonempty `message_id`. The
    // predicate is restated here so the planner can prove the index applies:
    // an equality on the column alone does not imply `message_id <> ''`, and
    // without this the message-keyed page would fall back to a full scan.
    if (this.keys === "bytes" && input.messageID !== undefined) conditions.push("message_id <> ''")
    if (input.after !== undefined) {
      const comparison = input.descending ? "<" : ">"
      // Row-value bounds let SQLite seek past the cursor instead of filtering the index prefix.
      // https://www.sqlite.org/rowvalue.html#scrolling_window_queries
      conditions.push(`(order_key, key_id) ${comparison} (?, ?)`)
      const order = metadata(input.after).order
      values.push(order, keyParameter(this.keys, input.after))
    }
    const limit = input.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
      throw new StorageIntegrityError("Invalid storage page limit")
    values.push(limit)
    const direction = input.descending ? "DESC" : "ASC"
    return this.connection.query<Row>(
      `SELECT ${columns} FROM storage_records WHERE ${conditions.join(" AND ")}${this.visibility()} ORDER BY order_key ${direction}, key_id ${direction} LIMIT ?`,
      values,
    )
  }

  async *records<T = unknown>(): AsyncGenerator<StoredRecord<T>> {
    let after = ""
    for (;;) {
      this.check()
      const page = await this.connection.query<RecordRow & { key_id: SqlValue }>(
        "SELECT r.key_id, r.key_text, r.body, r.revision FROM storage_records r WHERE r.namespace = ? AND r.body IS NOT NULL AND r.key_id > ?" +
          this.visibility("r") +
          " ORDER BY r.key_id LIMIT 256",
        [this.namespace, keyHexParameter(this.keys, after)],
      )
      if (!page.length) break
      // The retired format stored each node's full path text and this traversal
      // compared it with the record's key. Format 3 stores no path, so the same
      // invariant is checked directly against the node's own derived columns:
      // the node must exist, its segment must be this record's last segment, and
      // its parent link must name the record's parent prefix. A record whose
      // index disagrees with its key is unreachable by traversal, so a full walk
      // stops here rather than exporting evidence the store cannot address.
      // One keyed lookup per page, answered from the primary index.
      const nodes = await this.connection.query<{ key_id: SqlValue; parent_id: SqlValue; segment: string }>(
        `SELECT key_id, parent_id, segment FROM storage_nodes WHERE namespace = ? AND key_id IN (${page.map(() => "?").join(",")})`,
        [this.namespace, ...page.map((row) => row.key_id)],
      )
      const indexed = new Map(nodes.map((node) => [keyHex(node.key_id), node]))
      for (const row of page) {
        if (BigInt(row.revision) < 1n)
          throw new StorageIntegrityError("Logical storage index integrity verification failed")
        const key = JSON.parse(row.key_text) as string[]
        const node = indexed.get(keyID(key))
        if (!node || node.segment !== key.at(-1) || keyHex(node.parent_id) !== keyID(key.slice(0, -1)))
          throw new StorageIntegrityError("Logical storage index integrity verification failed")
        yield {
          key,
          value: RecordCodec.decode<T>(row.body!),
          revision: BigInt(row.revision),
        }
      }
      after = keyHex(page.at(-1)!.key_id)
    }
  }

  async *exportEntries(): AsyncGenerator<StorageEntry> {
    await this.assertAdmitted([[]], true)
    for await (const record of this.records())
      yield { type: "record", key: record.key, value: record.value, revision: record.revision.toString() }
    for await (const artifact of this.artifacts()) yield { type: "artifact", ...artifact }
    let operationID = ""
    for (;;) {
      const page = await this.connection.query(
        "SELECT operation_id, request_hash, result, created FROM storage_receipts WHERE namespace = ? AND operation_id > ? ORDER BY operation_id LIMIT 256",
        [this.namespace, operationID],
      )
      if (!page.length) break
      for (const row of page)
        yield {
          type: "receipt",
          operationID: String(row.operation_id),
          requestHash: String(row.request_hash),
          result: RecordCodec.text(recordBody(row.result)),
          created: Number(row.created),
        }
      operationID = String(page.at(-1)!.operation_id)
    }
    let position = 0n
    for (;;) {
      const page = await this.connection.query(
        "SELECT id, scope_id, type, payload, position FROM storage_events WHERE namespace = ? AND position > ? ORDER BY position LIMIT 256",
        [this.namespace, position],
      )
      if (!page.length) break
      for (const row of page)
        yield {
          type: "event",
          id: String(row.id),
          scopeID: String(row.scope_id),
          eventType: String(row.type),
          payload: RecordCodec.decode(recordBody(row.payload)),
        }
      position = BigInt(page.at(-1)!.position as bigint)
    }
  }

  async artifact(key: string[]): Promise<ArtifactLocation> {
    this.check()
    await this.assertAdmitted([key])
    keyID(key)
    const [row] = await this.connection.query(
      "SELECT location FROM storage_artifacts WHERE namespace = ? AND key_text = ?",
      [this.namespace, JSON.stringify(key)],
    )
    if (!row) throw new NotFoundError({ message: "Artifact does not exist" })
    return ArtifactLocation.parse(JSON.parse(String(row.location)))
  }

  async writeArtifacts(entries: Array<{ key: string[]; location: ArtifactLocation }>) {
    this.check(true)
    await this.assertAdmitted(entries.map((entry) => entry.key))
    // The pack column is an engine-derived one only in the generated layout, and
    // a writer must not name such a column. Which layout this namespace has is
    // read from its artifact table rather than assumed from the backend or the
    // recorded format: a format 3 SQLite namespace whose engine could not accept
    // or index a generated column keeps the physical one and needs it supplied,
    // exactly as a format 2 writer does.
    const generated = this.artifactPack === "generated"
    for (let start = 0; start < entries.length; start += 128) {
      const batch = entries.slice(start, start + 128)
      const owners = new Map<string, string[]>()
      for (const { key, location } of batch) {
        keyID(key)
        ArtifactLocation.parse(location)
        if (key[0] === "sessions" && key.length >= 4) {
          const owner = [...key.slice(0, 3), "info"]
          owners.set(JSON.stringify(owner), owner)
        }
      }
      for (const owner of owners.values()) await this.assertNotDeleted(owner)
      await this.connection.query(
        `INSERT INTO storage_artifact_gc(namespace, pack) SELECT namespace, pack FROM storage_artifacts WHERE namespace = ? AND key_text IN (${batch.map(() => "?").join(",")}) ON CONFLICT(namespace, pack) DO NOTHING`,
        [this.namespace, ...batch.map(({ key }) => JSON.stringify(key))],
      )
      await this.connection.query(
        generated
          ? `INSERT INTO storage_artifacts(namespace, key_text, owner_key, location) VALUES ${batch.map(() => "(?, ?, ?, ?)").join(",")} ON CONFLICT(namespace, key_text) DO UPDATE SET location = excluded.location`
          : `INSERT INTO storage_artifacts(namespace, key_text, owner_key, location, pack) VALUES ${batch.map(() => "(?, ?, ?, ?, ?)").join(",")} ON CONFLICT(namespace, key_text) DO UPDATE SET location = excluded.location, pack = excluded.pack`,
        batch.flatMap(({ key, location }) => [
          this.namespace,
          JSON.stringify(key),
          JSON.stringify(key.slice(0, ["sessions", "operations"].includes(key[0]) ? 3 : 1)),
          JSON.stringify(location),
          ...(generated ? [] : [location.pack]),
        ]),
      )
    }
  }

  async *artifactPacks(): AsyncGenerator<string> {
    this.check()
    let after = ""
    for (;;) {
      const rows = await this.connection.query(
        "SELECT DISTINCT pack FROM storage_artifacts WHERE namespace = ? AND pack > ? ORDER BY pack LIMIT 256",
        [this.namespace, after],
      )
      if (!rows.length) return
      for (const row of rows) yield String(row.pack)
      after = String(rows.at(-1)!.pack)
    }
  }

  async artifactGarbage() {
    this.check()
    const rows = await this.connection.query(
      "SELECT g.pack, CASE WHEN EXISTS (SELECT 1 FROM storage_artifacts a WHERE a.namespace = g.namespace AND a.pack = g.pack) THEN 1 ELSE 0 END AS used FROM storage_artifact_gc g WHERE g.namespace = ? ORDER BY g.pack LIMIT 256",
      [this.namespace],
    )
    return rows.map((row) => ({ pack: String(row.pack), used: Boolean(Number(row.used)) }))
  }

  async acknowledgeArtifactGarbage(packs: string[]) {
    this.check(true)
    if (!packs.length) return
    await this.connection.query(
      `DELETE FROM storage_artifact_gc WHERE namespace = ? AND pack IN (${packs.map(() => "?").join(",")})`,
      [this.namespace, ...packs],
    )
  }

  async *artifacts(): AsyncGenerator<{ key: string[]; location: ArtifactLocation }> {
    this.check()
    await this.assertAdmitted([[]], true)
    let after = ""
    for (;;) {
      const rows = await this.connection.query(
        "SELECT key_text, location FROM storage_artifacts WHERE namespace = ? AND key_text > ? ORDER BY key_text LIMIT 256",
        [this.namespace, after],
      )
      if (!rows.length) return
      for (const row of rows)
        yield {
          key: JSON.parse(String(row.key_text)) as string[],
          location: ArtifactLocation.parse(JSON.parse(String(row.location))),
        }
      after = String(rows.at(-1)!.key_text)
    }
  }

  async assertNotDeleted(key: string[]) {
    this.check()
    const [record] = await this.connection.query(
      "SELECT body FROM storage_records WHERE namespace = ? AND key_id = ?",
      [this.namespace, keyParameter(this.keys, key)],
    )
    if (record && record.body === null)
      throw new StorageConflictError("A deleted record cannot be revived by a delayed writer")
  }

  async restoreEntry(entry: StorageEntry) {
    this.check(true)
    if (entry.type === "artifact") {
      const [existing] = await this.connection.query(
        "SELECT location FROM storage_artifacts WHERE namespace = ? AND key_text = ?",
        [this.namespace, JSON.stringify(entry.key)],
      )
      if (existing) throw new StorageConflictError("Portable artifact conflicts with existing target data")
      await this.writeArtifacts([{ key: entry.key, location: entry.location }])
      return
    }
    if (entry.type === "record") {
      if (BigInt(entry.revision) > 9223372036854775807n) throw new StorageIntegrityError("Unsupported record revision")
      if ((await this.readMany([entry.key]))[0] !== undefined)
        throw new StorageConflictError("Portable record conflicts with existing target data")
      await this.put(entry.key, entry.value)
      await this.connection.query(
        "UPDATE storage_records SET revision = CASE WHEN revision > ? THEN revision ELSE ? END WHERE namespace = ? AND key_id = ?",
        [BigInt(entry.revision), BigInt(entry.revision), this.namespace, keyParameter(this.keys, entry.key)],
      )
      return
    }
    if (entry.type === "event") {
      await this.enqueue({ id: entry.id, scopeID: entry.scopeID, type: entry.eventType, payload: entry.payload })
      return
    }
    const [existing] = await this.connection.query(
      "SELECT request_hash, result FROM storage_receipts WHERE namespace = ? AND operation_id = ?",
      [this.namespace, entry.operationID],
    )
    if (existing) {
      // The archive carries JSON text, so this compares the stored body's text
      // rather than the frame a format 3 column holds.
      const stored = RecordCodec.text(recordBody(existing.result))
      if (existing.request_hash !== entry.requestHash || stored !== entry.result)
        throw new StorageConflictError("Command receipt conflicts with existing target data")
      return
    }
    // `reencode` carries the archive's JSON text across exactly rather than
    // parsing and re-serializing it, so a repeated import compares equal.
    JSON.parse(entry.result)
    await this.connection.query(
      "INSERT INTO storage_receipts(namespace, operation_id, request_hash, result, created) VALUES (?, ?, ?, ?, ?)",
      [
        this.namespace,
        entry.operationID,
        entry.requestHash,
        RecordCodec.reencode(entry.result, this.bodies),
        entry.created,
      ],
    )
  }

  async enqueue(event: StoredEvent): Promise<void> {
    this.check(true)
    const [counter] = await this.connection.query(
      "UPDATE storage_namespaces SET next_event = next_event + 1 WHERE namespace = ? RETURNING next_event",
      [this.namespace],
    )
    await this.connection.query(
      "INSERT INTO storage_events(namespace, id, scope_id, type, payload, position) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(namespace, id) DO NOTHING",
      [
        this.namespace,
        event.id,
        event.scopeID,
        event.type,
        RecordCodec.encode(event.payload, this.bodies),
        counter.next_event,
      ],
    )
  }
}

export class TransactionalStore {
  private readonly admission = { pending: true }
  hasUnpublishedOwners() {
    return this.admission.pending
  }
  private readonly writes = new StorageQueue("store.writes")
  private readonly owner = randomUUID()
  private closing?: Promise<void>
  private unavailable?: Error
  // Read from the namespace row at open and advanced by the format 3 rewrite,
  // which is the only writer that can change it. Kept as store state because a
  // live store cannot re-read the version per transaction without either adding
  // a round trip or breaking the declared single-statement read contract.
  private keyEncoding: KeyEncoding = "hex"
  // Read from the artifact table at open, for the same reason: a writer has to
  // know whether it may name `pack`, and the layout depends on what the engine
  // supported when the rewrite staged that table.
  private artifactPack: ArtifactPackLayout = "generated"
  private constructor(
    private readonly driver: SqlDriver,
    readonly options: StoreOptions,
  ) {}

  static async open(options: StoreOptions) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.namespace)) throw new StorageIntegrityError("Invalid storage namespace")
    const driver: SqlDriver =
      options.backend === "sqlite"
        ? await SqliteDriver.open(options.filename, options.readonly, options.mustExist)
        : await PostgresDriver.open(options.url, options.namespace, options.maxConnections, options.readonly)
    const store = new TransactionalStore(driver, options)
    driver.onUnavailable((error) => {
      store.unavailable = error
    })
    try {
      await driver.transaction(
        async (connection) => {
          if (!options.readonly)
            for (const statement of schemaFor(options.backend))
              await connection.query(statement, [], {
                // `CREATE INDEX` reads every existing row, so on a large store it
                // outlasts the ordinary request deadline. A DDL statement killed at
                // that deadline is rolled back, and because the index is then still
                // missing the next open repeats the same doomed build. `CREATE TABLE`
                // stays on the ordinary deadline: it is a no-op once the table exists.
                maintenance: statement.startsWith("CREATE INDEX") ? "create-index" : undefined,
              })
          const [existing] = await connection.query(
            "SELECT version, owner, state FROM storage_namespaces WHERE namespace = ?",
            [options.namespace],
          )
          if (options.mustExist && !existing) throw new StorageIntegrityError("The active storage namespace is missing")
          if (existing && ![1, 2, 3].includes(Number(existing.version)))
            throw new StorageIntegrityError("Unsupported authoritative storage version")
          // A fresh SQLite namespace is created with the format 3 layout, so it
          // is born current. A PostgreSQL namespace keeps the format 2 layout
          // and stays there: it has no rewrite to run and no byte encoding to
          // adopt. An existing namespace keeps whatever it recorded -- marking a
          // store current before its rows are rewritten is exactly what would
          // let a v2 store claim v3 while still holding hex keys.
          const version = existing ? Number(existing.version) : options.backend === "sqlite" ? 3 : 2
          store.keyEncoding = options.backend === "sqlite" && version >= 3 ? "bytes" : "hex"
          // The artifact layout is a property of the table, not of the recorded
          // format: a format 3 namespace falls back to a physical `pack` when its
          // engine cannot accept or index a generated one. PostgreSQL has no
          // `json_extract` and no table-valued pragma here, so it is always
          // physical.
          store.artifactPack =
            options.backend === "sqlite" ? await artifactPackLayout(connection, "storage_artifacts") : "physical"
          if (options.readonly) {
            if (existing && version === 1)
              throw new StorageIntegrityError(
                "Storage format upgrade required; run data storage resume before inspection",
              )
            if (!existing) throw new StorageIntegrityError("Storage namespace does not exist")
            return
          }
          if (existing?.state === "active" && options.backend === "postgres" && !options.recover)
            throw new StorageOwnershipError(
              "The previous PostgreSQL Runtime did not release ownership; verify it has stopped before recovering",
            )
          // The insert value applies only when the namespace is new. An existing
          // row keeps its own version: promoting it here would claim a layout the
          // rows do not have yet, and the rewrite is what stamps 3 once the bytes
          // are actually in place. A version below 2 is advanced to 2 because this
          // open has just created the format 2 indexes the store was missing.
          await connection.query(
            "INSERT INTO storage_namespaces(namespace, version, owner, state) VALUES (?, ?, ?, 'active') ON CONFLICT(namespace) DO UPDATE SET version = CASE WHEN storage_namespaces.version >= 2 THEN storage_namespaces.version ELSE 2 END, owner = excluded.owner, state = excluded.state",
            [options.namespace, options.backend === "sqlite" ? 3 : 2, store.owner],
          )
        },
        { readOnly: options.readonly },
      )
      const [pending] = await driver.query(
        "SELECT 1 FROM storage_records WHERE namespace = ? AND kind = 'compat_pending' AND body IS NOT NULL LIMIT 1",
        [options.namespace],
      )
      store.admission.pending = Boolean(pending)
      return store
    } catch (error) {
      await driver.close()
      throw error
    }
  }

  private check() {
    if (this.unavailable) throw this.unavailable
    if (this.closing) throw new StorageClosedError()
  }

  /** Reports a store that failed terminally; the host must restart the Runtime
   *  because this instance cannot serve further work. */
  onUnavailable(listener: (error: Error) => void): () => void {
    return this.driver.onUnavailable(listener)
  }

  get readiness() {
    const available = !this.unavailable && !this.closing
    if (!(this.driver instanceof SqliteDriver)) return { readerReady: available, writerReady: available }
    const status = this.driver.status
    return {
      readerReady: available && status.reader === "healthy",
      writerReady: available && status.writer === "healthy",
    }
  }

  async snapshot<T>(
    body: (snapshot: StoreTransaction) => Promise<T>,
    options: { singleStatement?: boolean } = {},
  ): Promise<T> {
    this.check()
    return this.driver.transaction(
      async (connection) => {
        const snapshot = new StoreTransaction(
          connection,
          this.options.namespace,
          true,
          this.keyEncoding,
          this.driver.backend,
          this.artifactPack,
          this.admission,
        )
        try {
          const result = await body(snapshot)
          snapshot.assertHealthy()
          return result
        } finally {
          snapshot.finish()
        }
      },
      { readOnly: true, singleStatement: options.singleStatement },
    )
  }

  transaction<T>(body: (tx: StoreTransaction) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    this.check()
    if (this.options.readonly) return Promise.reject(new StorageConflictError("The store is read-only"))
    if (options.operationID && !options.requestHash)
      return Promise.reject(new StorageIntegrityError("Idempotent commands require a request hash"))
    return this.writes.run(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.driver.transaction(async (connection) => {
            const [identity] = await connection.query(
              "SELECT owner, state FROM storage_namespaces WHERE namespace = ?" +
                (this.driver.backend === "postgres" ? " FOR SHARE" : ""),
              [this.options.namespace],
            )
            if (!identity || identity.owner !== this.owner || identity.state !== "active")
              throw new StorageOwnershipError("Runtime no longer owns this data namespace")
            if (options.operationID) {
              const [receipt] = await connection.query(
                "SELECT request_hash, result FROM storage_receipts WHERE namespace = ? AND operation_id = ?",
                [this.options.namespace, options.operationID],
              )
              if (receipt) {
                if (receipt.request_hash !== options.requestHash)
                  throw new StorageConflictError("Operation ID was already used for different input")
                return RecordCodec.decode<{ value: T }>(recordBody(receipt.result)).value
              }
            }
            const tx = new StoreTransaction(
              connection,
              this.options.namespace,
              false,
              this.keyEncoding,
              this.driver.backend,
              this.artifactPack,
              this.admission,
            )
            try {
              const result = await body(tx)
              tx.assertHealthy()
              if (options.operationID)
                await connection.query(
                  "INSERT INTO storage_receipts(namespace, operation_id, request_hash, result, created) VALUES (?, ?, ?, ?, ?)",
                  [
                    this.options.namespace,
                    options.operationID,
                    options.requestHash!,
                    RecordCodec.encode({ value: result }, bodyContainer(this.keyEncoding)),
                    Date.now(),
                  ],
                )
              return result
            } finally {
              tx.finish()
            }
          }, options)
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined
          if (
            this.driver.backend === "postgres" ||
            attempt >= 2 ||
            !["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT"].includes(code ?? "")
          )
            throw error
          await Bun.sleep(10 * 2 ** attempt + Math.floor(Math.random() * 10))
        }
      }
    }, options)
  }

  read<T = unknown>(key: string[]) {
    return this.snapshot((tx) => tx.read<T>(key), { singleStatement: true })
  }
  versioned<T = unknown>(key: string[]) {
    return this.snapshot((tx) => tx.versioned<T>(key), { singleStatement: true })
  }
  readMany<T = unknown>(keys: string[][]) {
    // Only a caller whose keys fit one batch issues one statement; a longer
    // list issues several, and only an explicit transaction holds those on one
    // snapshot.
    return this.snapshot((tx) => tx.readMany<T>(keys), { singleStatement: keys.length <= 128 })
  }
  write<T>(key: string[], value: T) {
    return this.transaction((tx) => tx.write(key, value))
  }
  update<T>(key: string[], change: (value: T) => void) {
    return this.transaction((tx) => tx.update(key, change))
  }
  remove(key: string[]) {
    return this.transaction((tx) => tx.remove(key))
  }
  removeTree(prefix: string[]) {
    return this.transaction((tx) => tx.removeTree(prefix))
  }
  scan(prefix: string[]) {
    return this.snapshot((tx) => tx.scan(prefix), { singleStatement: true })
  }
  list(prefix: string[]) {
    return this.snapshot((tx) => tx.list(prefix), { singleStatement: true })
  }
  query<T>(input: RecordQuery) {
    return this.snapshot((tx) => tx.query<T>(input), { singleStatement: true })
  }

  pruneTree(prefix: string[]) {
    return this.transaction((tx) => tx.pruneTree(prefix))
  }

  pruneTreeWithinBudget(prefix: string[], input: { limits: PruneLimits; cutoff: number; active(): boolean }) {
    return this.transaction(
      async (tx) => {
        if (input.active()) return { deferred: "active" as const, records: 0 }
        const deferred = await tx.pruneDeferral(prefix, input.limits, input.cutoff)
        if (deferred) return { deferred, records: 0 }
        if (input.active()) return { deferred: "active" as const, records: 0 }
        return { records: await tx.pruneTree(prefix), deferred: undefined }
      },
      { priority: "background" },
    )
  }

  get sqliteFilename() {
    return this.options.backend === "sqlite" ? this.options.filename : undefined
  }

  /**
   * Runs one DDL statement through the serialized writer and the maintenance
   * deadline.
   *
   * DDL belongs to the maintenance class: an index build reads every record, so
   * on a large store it outlasts the ordinary request deadline by minutes. A DDL
   * statement killed at that deadline is rolled back, and because the index is
   * then still missing the next open repeats the same doomed build. The caller
   * owns the statement text, so any interpolated identifier is its
   * responsibility to validate.
   */
  async maintainDdl(
    statement: string,
    operation: Extract<StorageMaintenanceOperation, "create-index" | "drop-index">,
  ): Promise<void> {
    this.check()
    if (this.options.readonly) throw new StorageConflictError("Maintenance requires a writable store")
    await this.writes.run(() =>
      this.driver.transaction(async (connection) => {
        await connection.query(statement, [], { maintenance: operation })
      }),
    )
  }

  /**
   * Runs several DDL statements as one atomic unit.
   *
   * The format rewrite has to drop a table, rename its replacement and rebuild
   * the indexes that drop removed. Committing those separately would expose a
   * window with no records table at all, and running them on the ordinary
   * deadline would roll the whole swap back on any store large enough for the
   * index build to outlast a request. SQLite DDL is transactional, so one
   * transaction leaves the previous table intact unless every statement
   * succeeds.
   *
   * `operation` opts the bundle into the maintenance lifecycle, and through it
   * the ceiling budget: an index build or rebuild is one engine call whose cost
   * grows with the store. Omit it for bookkeeping and staging DDL -- a migration
   * state row, a replacement table created for a batched copy -- which is
   * bounded by construction and would otherwise announce a lifecycle transition
   * for every batch of a copy that runs tens of thousands of them.
   */
  async maintainDdlTransaction(
    statements: Array<{ statement: string; values?: SqlValue[] }>,
    operation?: Extract<StorageMaintenanceOperation, "create-index" | "drop-index">,
    validate?: (connection: SqlConnection) => Promise<void>,
  ): Promise<void> {
    this.check()
    if (this.options.readonly) throw new StorageConflictError("Maintenance requires a writable store")
    if (!statements.length) return
    await this.writes.run(() =>
      this.driver.transaction(async (connection) => {
        await validate?.(connection)
        for (const { statement, values } of statements)
          await connection.query(statement, values ?? [], operation ? { maintenance: operation } : undefined)
      }),
    )
  }

  /** The key encoding this namespace's key columns currently hold. */
  get keyEncodedAs() {
    return this.keyEncoding
  }

  /**
   * Adopts the format 3 layout after the swap commits.
   *
   * The encoding follows the namespace's recorded format, and the rewrite is the
   * only transition that changes it. A store must not re-read the version per
   * statement -- reads declare a single-statement contract -- so the swap flips
   * this in the same process that performed it.
   *
   * The artifact layout comes from the swap because it is not implied by the
   * format: the rewrite stages the generated column when the engine supports it
   * and falls back to a physical one when it does not, so the caller that
   * performed the swap is the one place that already knows which of the two the
   * renamed table has.
   */
  adoptFormatV3(artifactPack: ArtifactPackLayout) {
    this.keyEncoding = "bytes"
    this.artifactPack = artifactPack
  }

  /**
   * Drops a retired index. `IF EXISTS` makes the statement a no-op on a store
   * that never created the index, which is what keeps the owning migration safe
   * to re-run. The identifier is interpolated into DDL rather than bound, so it
   * is validated first.
   */
  async dropIndexIfExists(index: string): Promise<void> {
    this.check()
    if (!/^[a-z_][a-z0-9_]*$/.test(index)) throw new StorageIntegrityError("Invalid storage index name")
    await this.maintainDdl(`DROP INDEX IF EXISTS ${index}`, "drop-index")
  }

  /**
   * Evidence owners with the recency of their newest record. Only indexed
   * columns and timestamps are read. Work scales with the live rollout index
   * entries; the returned result scales with owner count.
   *
   * Rollout owners come from the `storage_records_owner` partial index, whose
   * key carries `scope_id`, `session_id` and `updated` after the `kind` prefix.
   * That is what lets the group resolve per owner; without it the group is a
   * temporary b-tree over every rollout row. `MIN(key_text)` must not come back:
   * `key_text` is not in the index, so selecting it forces a table walk per row
   * and the index stops paying for itself.
   *
   * Operation records store no owner columns -- their `scope_id` and
   * `session_id` are empty -- so they keep the key-text form. There are only
   * thousands of them, which keeps that form bounded.
   */
  async evidenceOwners(): Promise<
    Array<{ keyPrefix: string[]; kind: string; scopeID: string; ownerID: string; newest: number; records: number }>
  > {
    this.check()
    // PostgreSQL has no in-file freelist and no incremental reclaim, so it has
    // no budget for retention to defend; pruning is SQLite-only.
    if (this.driver.backend !== "sqlite") return []
    return measureStorageOperation("evidenceOwners", "storage_records", async () => {
      const rows = await this.driver.query(
        `SELECT scope_id, session_id, MAX(updated) AS newest, COUNT(*) AS records FROM storage_records WHERE namespace = ? AND kind = 'rollout' AND body IS NOT NULL AND NOT EXISTS (SELECT 1 FROM storage_records pending WHERE pending.namespace = storage_records.namespace AND pending.kind = 'compat_pending' AND pending.order_key = storage_records.session_id AND pending.body IS NOT NULL) GROUP BY scope_id, session_id`,
        [this.options.namespace],
      )
      const operations = await this.driver.query(
        `SELECT MIN(key_text) AS key_text, MAX(updated) AS newest, COUNT(*) AS records FROM storage_records WHERE namespace = ? AND kind = 'operations' AND body IS NOT NULL GROUP BY json_extract(key_text, '$[1]'), json_extract(key_text, '$[2]')`,
        [this.options.namespace],
      )
      const sessions = rows.flatMap((row) => {
        const scopeID = String(row.scope_id)
        const sessionID = String(row.session_id)
        // Rollout evidence is addressed through the canonical owner composer
        // rather than a literal, so a change to the storage key layout cannot
        // leave retention pruning a prefix that no longer names this evidence. A
        // row whose owner columns are empty has no such prefix, and pruning
        // irreversible evidence through a prefix that does not name it is worse
        // than leaving it in place, so it is not an owner.
        if (!scopeID || !sessionID) return []
        return [
          {
            keyPrefix: StoragePath.sessionRolloutRoot(Identifier.asScopeID(scopeID), Identifier.asSessionID(sessionID)),
            kind: "session",
            scopeID,
            ownerID: sessionID,
            newest: Number(row.newest),
            records: Number(row.records),
          },
        ]
      })
      const others = operations.flatMap((row) => {
        const key = JSON.parse(String(row.key_text)) as string[]
        if (key.length < 4) return []
        return [
          {
            keyPrefix: key.slice(0, 4),
            kind: "operation",
            scopeID: key[1]!,
            ownerID: key[2]!,
            newest: Number(row.newest),
            records: Number(row.records),
          },
        ]
      })
      return [...sessions, ...others]
    })
  }

  /**
   * Runs one offline SQLite maintenance operation through the owning worker.
   * PostgreSQL keeps no in-file freelist, so it reports nothing to do.
   *
   * Maintenance holds the same serialized writer an ordinary transaction does,
   * so it acquires the same admission slot. Reserving the writer without
   * consuming a slot would let a long maintenance pass hold every waiting
   * caller past its deadline while the queue still reports itself as free.
   */
  async walPressure() {
    this.check()
    const driver = this.driver
    if (!(driver instanceof SqliteDriver)) return 0
    return this.writes.run(() => driver.walPressure())
  }

  async incrementalVacuumEnabled() {
    if (this.driver.backend !== "sqlite") return true
    const [row] = await this.driver.query("PRAGMA auto_vacuum")
    return Number(row?.auto_vacuum) === 2
  }

  async maintain(request: SqliteMaintenanceRequest): Promise<SqliteMaintenanceResult> {
    this.check()
    if (this.options.readonly) throw new StorageConflictError("Maintenance requires a writable store")
    if (!(this.driver instanceof SqliteDriver))
      return { changed: false, autoVacuum: "none", releasedPages: 0, freelistPages: 0 }
    const driver = this.driver
    return this.writes.run(() => driver.maintain(request))
  }

  async operationReceipt(operationID: string) {
    this.check()
    const [receipt] = await measureStorageOperation("operationReceipt", "storage_receipts", () =>
      this.driver.query("SELECT request_hash, result FROM storage_receipts WHERE namespace = ? AND operation_id = ?", [
        this.options.namespace,
        operationID,
      ]),
    )
    return receipt
      ? { requestHash: String(receipt.request_hash), result: RecordCodec.decode(recordBody(receipt.result)) }
      : undefined
  }

  async pendingEventCount(): Promise<number> {
    this.check()
    const [row] = await measureStorageOperation("pendingEventCount", "storage_events", () =>
      this.driver.query("SELECT COUNT(*) AS count FROM storage_events WHERE namespace = ?", [this.options.namespace]),
    )
    return Number(row.count)
  }

  async pendingEvents(limit = 100): Promise<StoredEvent[]> {
    this.check()
    const rows = await measureStorageOperation("pendingEvents", "storage_events", () =>
      this.driver.query(
        "SELECT id, scope_id, type, payload FROM storage_events WHERE namespace = ? ORDER BY position LIMIT ?",
        [this.options.namespace, limit],
      ),
    )
    return rows.map((row) => ({
      id: String(row.id),
      scopeID: String(row.scope_id),
      type: String(row.type),
      payload: RecordCodec.decode(recordBody(row.payload)),
    }))
  }

  async acknowledgeEvents(ids: string[]): Promise<void> {
    this.check()
    await this.writes.run(() =>
      this.driver.transaction(async (connection) => {
        const [owner] = await connection.query("SELECT owner FROM storage_namespaces WHERE namespace = ?", [
          this.options.namespace,
        ])
        if (this.options.readonly || owner?.owner !== this.owner)
          throw new StorageOwnershipError("Cannot acknowledge events without Runtime ownership")
        for (const id of ids)
          await connection.query("DELETE FROM storage_events WHERE namespace = ? AND id = ?", [
            this.options.namespace,
            id,
          ])
      }),
    )
  }

  async verify(progress?: (current: number) => void) {
    this.check()
    progress?.(0)
    let work = 0
    return observeStorageProgress(
      (recordProgress) =>
        this.driver.transaction(
          async (connection) => {
            if (this.driver.backend === "sqlite") {
              const rows = await connection.query("PRAGMA integrity_check", [], {
                // A physical check is one engine call with no progress callback, so
                // it cannot be split and its cost grows with the store. The driver
                // reports the ceiling as this operation's budget on the maintenance
                // lifecycle, which is the deadline the host waits on for the stage.
                maintenance: "integrity-check",
              })
              if (rows.length !== 1 || rows[0].integrity_check !== "ok")
                throw new StorageIntegrityError("SQLite integrity verification failed")
            }
            const tx = new StoreTransaction(
              connection,
              this.options.namespace,
              true,
              this.keyEncoding,
              this.driver.backend,
              this.artifactPack,
              this.admission,
            )
            const issues: Array<{ key: string[]; reason: string }> = []
            const kinds: Record<string, number> = {}
            let records = 0
            /**
             * Nodes whose subtree holds no record at all.
             *
             * The test is subtree reachability, not an own-record lookup: an
             * interior node legitimately holds no record of its own, and the
             * `LIMIT 1` stops at the first record found, so a healthy subtree
             * costs one probe. Pages are bounded by node key.
             *
             * A tombstoned record counts as a record row. `remove` and
             * `removeTree` keep a revision tombstone per record -- that fence is
             * what stops a delayed writer reviving deleted data -- and they drop
             * the node chain the removal emptied. Those rows therefore retain
             * their tombstones but not their nodes, which is why the test counts
             * any record row rather than only a live one. A node with no record
             * row anywhere beneath it is unreachable garbage, which is what an
             * interrupted `pruneTree` leaves between its record delete and its
             * node delete.
             */
            /**
             * Reconstructs each node's full key by walking `parent_id` to the
             * root.
             *
             * Assembling this in JavaScript rather than through a recursive
             * `json_insert` keeps the prefix order exact: the chain is collected
             * as rows and ordered by depth, so a node's path is its segments from
             * the root down. One statement serves a whole page of node keys.
             */
            const ancestorPaths = async (nodeKeys: SqlValue[]) => {
              const paths = new Map<string, string[]>()
              if (!nodeKeys.length) return paths
              const rows = await connection.query<{ root: SqlValue; segment: string; depth: bigint | number }>(
                `WITH RECURSIVE up(root, key_id, parent_id, segment, depth) AS (
                   SELECT key_id, key_id, parent_id, segment, 0 FROM storage_nodes
                   WHERE namespace = ? AND key_id IN (${nodeKeys.map(() => "?").join(",")})
                   UNION ALL
                   SELECT up.root, p.key_id, p.parent_id, p.segment, up.depth + 1
                   FROM up JOIN storage_nodes p ON p.namespace = ? AND p.key_id = up.parent_id
                 )
                 SELECT root, segment, depth FROM up`,
                [this.options.namespace, ...nodeKeys, this.options.namespace],
              )
              const levels = new Map<string, Array<{ segment: string; depth: number }>>()
              for (const row of rows) {
                const root = keyHex(row.root)
                const chain = levels.get(root) ?? []
                chain.push({ segment: row.segment, depth: Number(row.depth) })
                levels.set(root, chain)
              }
              for (const [root, chain] of levels)
                paths.set(
                  root,
                  chain.sort((left, right) => right.depth - left.depth).map((level) => level.segment),
                )
              return paths
            }
            const collectOrphanNodes = async () => {
              const orphans: Array<{ key: string[]; reason: string }> = []
              let cursor = keyHexParameter(this.keyEncoding, "")
              for (;;) {
                // The orphan test is subtree reachability, not an own-record
                // lookup: an interior node legitimately holds no record of its
                // own, and `LIMIT 1` stops at the first live descendant, so a
                // healthy subtree costs one probe. Pages are bounded by node key.
                const page = await connection.query<{ key_id: SqlValue }>(
                  `SELECT n.key_id FROM storage_nodes n
                   WHERE n.namespace = ? AND n.key_id > ?
                     AND NOT EXISTS (
                       WITH RECURSIVE tree(k) AS (
                         SELECT n.key_id
                         UNION ALL
                         SELECT c.key_id FROM tree
                         JOIN storage_nodes c ON c.namespace = n.namespace AND c.parent_id = tree.k
                       )
                       SELECT 1 FROM tree
                       JOIN storage_records r ON r.namespace = n.namespace AND r.key_id = tree.k
                       LIMIT 1
                     )
                   ORDER BY n.key_id LIMIT 256`,
                  [this.options.namespace, cursor],
                )
                if (!page.length) break
                const chain = await ancestorPaths(page.map((row) => row.key_id))
                for (const row of page) {
                  const path = chain.get(keyHex(row.key_id))
                  if (!path) continue
                  orphans.push({ key: path, reason: "node_without_record" })
                }
                cursor = keyHexParameter(this.keyEncoding, keyHex(page.at(-1)!.key_id))
              }
              return orphans
            }
            try {
              let batch: StoredRecord<Record<string, unknown>>[] = []
              const verifyBatch = async () => {
                const parents = new Map<string, string[]>()
                for (const { key } of batch) {
                  if (key[0] !== "sessions") continue
                  if (key[3] !== "info") {
                    const owner = [...key.slice(0, 3), "info"]
                    parents.set(JSON.stringify(owner), owner)
                  }
                  if (metadata(key).kind === "part") {
                    const message = [...key.slice(0, 5), "info"]
                    parents.set(JSON.stringify(message), message)
                  }
                }
                const keys = [...parents.keys()]
                const values = await tx.readMany([...parents.values()])
                const present = new Set(keys.filter((_, index) => values[index] !== undefined))
                // The retired index carried the full path text per level, and the
                // old check compared that text with the record's key. Format 3
                // stores no path, so the equivalent check reconstructs it: each
                // live record's node must exist, and its chain of segments down
                // from the root must name exactly that record's key. A missing
                // node row-- or one whose segment or parent link was altered--
                // fails here, and a live record that traversal cannot reach is
                // corruption rather than an orphan.
                const nodeKeys = batch.map(({ key }) => keyColumnValue(this.keyEncoding, key))
                const indexed = await connection.query<{ key_id: SqlValue }>(
                  `SELECT key_id FROM storage_nodes WHERE namespace = ? AND key_id IN (${nodeKeys.map(() => "?").join(",")})`,
                  [this.options.namespace, ...nodeKeys],
                )
                const presentNodes = new Set(indexed.map((node) => keyHex(node.key_id)))
                for (const record of batch) {
                  if (!presentNodes.has(keyID(record.key)))
                    throw new StorageIntegrityError("Logical storage index integrity verification failed")
                }
                const chains = await ancestorPaths(nodeKeys)
                for (const record of batch) {
                  const path = chains.get(keyID(record.key))
                  if (!path || JSON.stringify(path) !== JSON.stringify(record.key))
                    throw new StorageIntegrityError("Logical storage index integrity verification failed")
                }
                for (const record of batch) {
                  records++
                  const meta = metadata(record.key)
                  kinds[meta.kind] = (kinds[meta.kind] ?? 0) + 1
                  const key = record.key
                  if (key[0] !== "sessions") continue
                  if (key[3] !== "info" && !present.has(JSON.stringify([...key.slice(0, 3), "info"])))
                    issues.push({ key, reason: "missing_session" })
                  if (meta.kind === "part" && !present.has(JSON.stringify([...key.slice(0, 5), "info"])))
                    issues.push({ key, reason: "missing_message" })
                  if (["session", "message", "part"].includes(meta.kind)) {
                    const expectedID = meta.kind === "part" ? key.at(-1) : key.at(-2)
                    if (!record.value || typeof record.value !== "object" || record.value.id !== expectedID)
                      issues.push({ key, reason: "identity_mismatch" })
                  }
                }
                work += batch.length
                recordProgress(work)
                batch = []
              }
              for await (const record of tx.records<Record<string, unknown>>()) {
                batch.push(record)
                if (batch.length === 256) await verifyBatch()
              }
              if (batch.length) await verifyBatch()
              for (const orphan of await collectOrphanNodes()) issues.push(orphan)
              recordProgress(work)
              return { backend: this.driver.backend, namespace: this.options.namespace, records, kinds, issues }
            } finally {
              tx.finish()
            }
          },
          { readOnly: true },
        ),
      progress,
    )
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.writes.close()
      try {
        if (!this.options.readonly) {
          const release = (connection: SqlConnection) =>
            connection.query(
              "UPDATE storage_namespaces SET state = 'idle', owner = '' WHERE namespace = ? AND owner = ?",
              [this.options.namespace, this.owner],
            )
          if (this.driver.backend === "postgres") await release(this.driver)
          else await this.driver.transaction(release)
        }
      } catch (error) {
        // A store that already failed terminally cannot write its idle row; the
        // primary failure was reported when it happened, so closing must release
        // the driver without replacing it with a secondary error.
        if (
          !(error instanceof StorageOwnershipError) &&
          !(error instanceof StorageClosedError) &&
          !(error instanceof StorageUnavailableError)
        )
          throw error
      } finally {
        await this.driver.close()
      }
    })()
    return this.closing
  }
}
