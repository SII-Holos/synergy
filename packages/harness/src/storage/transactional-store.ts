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
import { RecordCodec } from "./record-codec"
import { measureStorageOperation } from "./measure"
import { StorageQueue } from "./queue"
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
export interface TransactionOptions {
  operationID?: string
  requestHash?: string
}
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

type RecordRow = SqlRow & { key_text: string; body: string | null; revision: bigint | number | string }

function keyID(key: readonly string[]) {
  if (!Array.isArray(key) || key.some((value) => typeof value !== "string" || value.length === 0))
    throw new StorageIntegrityError("A storage key must contain nonempty string segments")
  return createHash("sha256").update(JSON.stringify(key)).digest("hex")
}

function encode(value: unknown) {
  const result = JSON.stringify(value)
  if (result === undefined) throw new StorageIntegrityError("A storage record must be JSON serializable")
  return result
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

const schema = [
  "CREATE TABLE IF NOT EXISTS storage_artifact_gc (namespace TEXT NOT NULL, pack TEXT NOT NULL, PRIMARY KEY(namespace, pack))",
  "CREATE TABLE IF NOT EXISTS storage_artifacts (namespace TEXT NOT NULL, key_text TEXT NOT NULL, owner_key TEXT NOT NULL, location TEXT NOT NULL, pack TEXT NOT NULL, PRIMARY KEY(namespace, key_text))",
  "CREATE INDEX IF NOT EXISTS storage_artifacts_owner ON storage_artifacts(namespace, owner_key)",
  "CREATE INDEX IF NOT EXISTS storage_artifacts_pack ON storage_artifacts(namespace, pack)",
  "CREATE TABLE IF NOT EXISTS storage_namespaces (namespace TEXT PRIMARY KEY, version INTEGER NOT NULL, owner TEXT NOT NULL, state TEXT NOT NULL, next_event BIGINT NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS storage_nodes (namespace TEXT NOT NULL, key_id TEXT NOT NULL, parent_id TEXT NOT NULL, key_text TEXT NOT NULL, segment TEXT NOT NULL, PRIMARY KEY(namespace, key_id))",
  "CREATE INDEX IF NOT EXISTS storage_nodes_parent ON storage_nodes(namespace, parent_id)",
  "CREATE TABLE IF NOT EXISTS storage_records (namespace TEXT NOT NULL, key_id TEXT NOT NULL, key_text TEXT NOT NULL, body TEXT, revision BIGINT NOT NULL, kind TEXT NOT NULL, scope_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, order_key TEXT NOT NULL, updated BIGINT NOT NULL, PRIMARY KEY(namespace, key_id))",
  "CREATE INDEX IF NOT EXISTS storage_records_session ON storage_records(namespace, session_id, kind, order_key, key_id)",
  "CREATE INDEX IF NOT EXISTS storage_records_message ON storage_records(namespace, message_id, kind, order_key, key_id)",
  "CREATE INDEX IF NOT EXISTS storage_records_kind ON storage_records(namespace, kind, order_key, key_id)",
  STORAGE_RECORDS_OWNER_INDEX,
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
  constructor(
    connection: SqlConnection,
    readonly namespace: string,
    private readonly readonly = false,
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
      [this.namespace, keyID(key)],
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
      const rows = await this.connection.query<RecordRow & { key_id: string }>(
        `SELECT key_id, key_text, body, revision FROM storage_records WHERE namespace = ? AND key_id IN (${batch.map(() => "?").join(",")})`,
        [this.namespace, ...batch.map(keyID)],
      )
      const index = new Map(rows.map((row) => [row.key_id, row]))
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
      const body = RecordCodec.encode(value)
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
      const rows = await this.connection.query<RecordRow & { key_id: string }>(
        `SELECT key_id, key_text, body, revision FROM storage_records WHERE namespace = ? AND key_id IN (${identities.map(() => "?").join(",")})`,
        [this.namespace, ...identities],
      )
      const previous = new Map(rows.map((row) => [row.key_id, row]))
      for (const [id, key] of owners) {
        const row = previous.get(id)
        if (row && row.key_text !== JSON.stringify(key))
          throw new StorageIntegrityError("Logical key identity collision")
        if (row?.body === null) throw new StorageConflictError("A deleted record cannot be revived by a delayed writer")
      }
      const nodes = new Map<string, SqlValue[]>()
      const values: SqlValue[] = []
      for (const entry of batch) {
        const before = previous.get(entry.id)
        if (before && before.key_text !== entry.text) throw new StorageIntegrityError("Logical key identity collision")
        for (let depth = 1; depth <= entry.key.length; depth++) {
          const prefix = entry.key.slice(0, depth)
          const id = keyID(prefix)
          nodes.set(id, [this.namespace, id, keyID(prefix.slice(0, -1)), JSON.stringify(prefix), prefix.at(-1)!])
        }
        values.push(
          this.namespace,
          entry.id,
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
          `INSERT INTO storage_nodes(namespace, key_id, parent_id, key_text, segment) VALUES ${group.map(() => "(?, ?, ?, ?, ?)").join(",")} ON CONFLICT(namespace, key_id) DO NOTHING`,
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
    const nodes: SqlValue[] = []
    for (let depth = 1; depth <= key.length; depth++) {
      const prefix = key.slice(0, depth)
      nodes.push(this.namespace, keyID(prefix), keyID(prefix.slice(0, -1)), JSON.stringify(prefix), prefix.at(-1)!)
    }
    await this.connection.query(
      `INSERT INTO storage_nodes(namespace, key_id, parent_id, key_text, segment) VALUES ${key.map(() => "(?, ?, ?, ?, ?)").join(",")} ON CONFLICT(namespace, key_id) DO NOTHING`,
      nodes,
    )
    const meta = metadata(key)
    await this.connection.query(
      "INSERT INTO storage_records(namespace, key_id, key_text, body, revision, kind, scope_id, session_id, message_id, order_key, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(namespace, key_id) DO UPDATE SET body = excluded.body, revision = excluded.revision, kind = excluded.kind, scope_id = excluded.scope_id, session_id = excluded.session_id, message_id = excluded.message_id, order_key = excluded.order_key, updated = excluded.updated",
      [
        this.namespace,
        keyID(key),
        JSON.stringify(key),
        RecordCodec.encode(value),
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
      [Date.now(), this.namespace, keyID(key)],
    )
  }

  async removeMany(keys: string[][]): Promise<void> {
    this.check(true)
    await this.assertAdmitted(keys)
    for (let offset = 0; offset < keys.length; offset += 128) {
      const batch = keys.slice(offset, offset + 128).map(keyID)
      await this.connection.query(
        `UPDATE storage_records SET body = NULL, revision = revision + 1, updated = ? WHERE namespace = ? AND key_id IN (${batch.map(() => "?").join(",")}) AND body IS NOT NULL`,
        [Date.now(), this.namespace, ...batch],
      )
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
      [this.namespace, keyID(prefix), this.namespace, this.namespace],
    )
    return rows.map((row) => row.child).sort()
  }

  async list(prefix: string[]): Promise<string[][]> {
    this.check()
    const rows = await this.connection.query<SqlRow & { key_text: string }>(
      "WITH RECURSIVE tree(key_id) AS (SELECT key_id FROM storage_nodes WHERE namespace = ? AND parent_id = ? UNION ALL SELECT node.key_id FROM tree CROSS JOIN storage_nodes node WHERE node.namespace = ? AND node.parent_id = tree.key_id) SELECT record.key_text FROM tree CROSS JOIN storage_records record WHERE record.key_id = tree.key_id AND record.namespace = ? AND record.body IS NOT NULL" +
        this.visibility("record"),
      [this.namespace, keyID(prefix), this.namespace, this.namespace],
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
      return
    }
    await this.connection.query(
      "WITH RECURSIVE tree(key_id) AS (SELECT key_id FROM storage_nodes WHERE namespace = ? AND key_id = ? UNION ALL SELECT node.key_id FROM tree CROSS JOIN storage_nodes node WHERE node.namespace = ? AND node.parent_id = tree.key_id) UPDATE storage_records SET body = NULL, revision = revision + 1, updated = ? WHERE namespace = ? AND key_id IN (SELECT key_id FROM tree) AND body IS NOT NULL",
      [this.namespace, keyID(prefix), this.namespace, Date.now(), this.namespace],
    )
  }

  /**
   * Physically removes a subtree. Retention uses this instead of `removeTree`
   * because a budgeted prune must return the bytes: `removeTree` leaves a
   * revision tombstone per record, which keeps the rows and their pages. Node
   * rows drop in dependency order so the logical index cannot keep a pruned
   * path reachable, and removed artifact references enqueue the same durable
   * collection intent ordinary deletion uses.
   */
  async pruneTree(prefix: string[]): Promise<number> {
    this.check(true)
    await this.assertAdmitted([prefix], true)
    if (!prefix.length) throw new StorageIntegrityError("Cannot prune the storage root")
    const text = JSON.stringify(prefix)
    const like = (text.slice(0, -1) + ",").replace(/[!%_]/g, (value) => "!" + value) + "%"
    const artifactCondition = "namespace = ? AND (key_text = ? OR key_text LIKE ? ESCAPE '!')"
    const artifactValues: SqlValue[] = [this.namespace, text, like]
    await this.connection.query(
      `INSERT INTO storage_artifact_gc(namespace, pack) SELECT namespace, pack FROM storage_artifacts WHERE ${artifactCondition} ON CONFLICT(namespace, pack) DO NOTHING`,
      artifactValues,
    )
    await this.connection.query(`DELETE FROM storage_artifacts WHERE ${artifactCondition}`, artifactValues)
    const removed = await this.connection.query<SqlRow>(
      "WITH RECURSIVE tree(key_id) AS (SELECT key_id FROM storage_nodes WHERE namespace = ? AND key_id = ? UNION ALL SELECT node.key_id FROM tree CROSS JOIN storage_nodes node WHERE node.namespace = ? AND node.parent_id = tree.key_id) DELETE FROM storage_records WHERE namespace = ? AND key_id IN (SELECT key_id FROM tree) RETURNING key_id",
      [this.namespace, keyID(prefix), this.namespace, this.namespace],
    )
    for (let round = 0; round < 64; round++) {
      const dropped = await this.connection.query<SqlRow>(
        "WITH RECURSIVE tree(key_id) AS (SELECT key_id FROM storage_nodes WHERE namespace = ? AND key_id = ? UNION ALL SELECT node.key_id FROM tree CROSS JOIN storage_nodes node WHERE node.namespace = ? AND node.parent_id = tree.key_id) DELETE FROM storage_nodes WHERE namespace = ? AND key_id IN (SELECT key_id FROM tree) AND NOT EXISTS (SELECT 1 FROM storage_records record WHERE record.namespace = ? AND record.key_id = storage_nodes.key_id) AND NOT EXISTS (SELECT 1 FROM storage_nodes child WHERE child.namespace = ? AND child.parent_id = storage_nodes.key_id) RETURNING key_id",
        [this.namespace, keyID(prefix), this.namespace, this.namespace, this.namespace, this.namespace],
      )
      if (!dropped.length) break
    }
    return removed.length
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
    if (input.after !== undefined) {
      const comparison = input.descending ? "<" : ">"
      // Row-value bounds let SQLite seek past the cursor instead of filtering the index prefix.
      // https://www.sqlite.org/rowvalue.html#scrolling_window_queries
      conditions.push(`(order_key, key_id) ${comparison} (?, ?)`)
      const order = metadata(input.after).order
      values.push(order, keyID(input.after))
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
      const page = await this.connection.query<RecordRow & { key_id: string; node_key_text: string | null }>(
        "SELECT r.key_id, r.key_text, r.body, r.revision, n.key_text AS node_key_text FROM storage_records r LEFT JOIN storage_nodes n ON n.namespace = r.namespace AND n.key_id = r.key_id WHERE r.namespace = ? AND r.body IS NOT NULL AND r.key_id > ?" +
          this.visibility("r") +
          " ORDER BY r.key_id LIMIT 256",
        [this.namespace, after],
      )
      if (!page.length) break
      for (const row of page) {
        if (row.node_key_text !== row.key_text || BigInt(row.revision) < 1n)
          throw new StorageIntegrityError("Logical storage index integrity verification failed")
        yield {
          key: JSON.parse(row.key_text) as string[],
          value: RecordCodec.decode<T>(row.body!),
          revision: BigInt(row.revision),
        }
      }
      after = page.at(-1)!.key_id
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
          result: String(row.result),
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
          payload: JSON.parse(String(row.payload)) as unknown,
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
        `INSERT INTO storage_artifacts(namespace, key_text, owner_key, location, pack) VALUES ${batch.map(() => "(?, ?, ?, ?, ?)").join(",")} ON CONFLICT(namespace, key_text) DO UPDATE SET location = excluded.location, pack = excluded.pack`,
        batch.flatMap(({ key, location }) => [
          this.namespace,
          JSON.stringify(key),
          JSON.stringify(key.slice(0, ["sessions", "operations"].includes(key[0]) ? 3 : 1)),
          JSON.stringify(location),
          location.pack,
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
      [this.namespace, keyID(key)],
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
        [BigInt(entry.revision), BigInt(entry.revision), this.namespace, keyID(entry.key)],
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
      if (existing.request_hash !== entry.requestHash || existing.result !== entry.result)
        throw new StorageConflictError("Command receipt conflicts with existing target data")
      return
    }
    JSON.parse(entry.result)
    await this.connection.query(
      "INSERT INTO storage_receipts(namespace, operation_id, request_hash, result, created) VALUES (?, ?, ?, ?, ?)",
      [this.namespace, entry.operationID, entry.requestHash, entry.result, entry.created],
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
      [this.namespace, event.id, event.scopeID, event.type, encode(event.payload), counter.next_event],
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
    driver.onUnavailable?.((error) => {
      store.unavailable = error
    })
    try {
      await driver.transaction(
        async (connection) => {
          if (!options.readonly)
            for (const statement of schema)
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
          if (existing && ![1, 2].includes(Number(existing.version)))
            throw new StorageIntegrityError("Unsupported authoritative storage version")
          if (options.readonly) {
            if (existing && Number(existing.version) === 1)
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
          await connection.query(
            "INSERT INTO storage_namespaces(namespace, version, owner, state) VALUES (?, 2, ?, 'active') ON CONFLICT(namespace) DO UPDATE SET version = excluded.version, owner = excluded.owner, state = excluded.state",
            [options.namespace, store.owner],
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
    return this.driver.onUnavailable?.(listener) ?? (() => {})
  }

  async snapshot<T>(
    body: (snapshot: StoreTransaction) => Promise<T>,
    options: { singleStatement?: boolean } = {},
  ): Promise<T> {
    this.check()
    return this.driver.transaction(
      async (connection) => {
        const snapshot = new StoreTransaction(connection, this.options.namespace, true, this.admission)
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
                return (JSON.parse(String(receipt.result)) as { value: T }).value
              }
            }
            const tx = new StoreTransaction(connection, this.options.namespace, false, this.admission)
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
                    encode({ value: result }),
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
    })
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
      ? { requestHash: String(receipt.request_hash), result: JSON.parse(String(receipt.result)) as unknown }
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
      payload: JSON.parse(String(row.payload)) as unknown,
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
                maintenance: "integrity-check",
              })
              if (rows.length !== 1 || rows[0].integrity_check !== "ok")
                throw new StorageIntegrityError("SQLite integrity verification failed")
            }
            const tx = new StoreTransaction(connection, this.options.namespace, true, this.admission)
            const issues: Array<{ key: string[]; reason: string }> = []
            const kinds: Record<string, number> = {}
            let records = 0
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
