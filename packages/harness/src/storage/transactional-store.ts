import type { StorageEntry } from "./portable"
import { createHash, randomUUID } from "node:crypto"
import {
  NotFoundError,
  StorageClosedError,
  StorageConflictError,
  StorageIntegrityError,
  StorageOwnershipError,
} from "./errors"
import { StorageQueue } from "./queue"
import { observeStorageProgress } from "./progress"
import { SqliteDriver } from "./sqlite-driver"
import { PostgresDriver } from "./postgres-driver"
import type { SqlConnection, SqlDriver, SqlRow, SqlValue, StoreOptions } from "./sql-contract"

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
    scope: key[0] === "projects" ? (key[1] ?? "") : "",
    session: "",
    message: "",
    order: key.at(-1)!,
  }
}

const schema = [
  "CREATE TABLE IF NOT EXISTS storage_namespaces (namespace TEXT PRIMARY KEY, version INTEGER NOT NULL, owner TEXT NOT NULL, state TEXT NOT NULL, next_event BIGINT NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS storage_nodes (namespace TEXT NOT NULL, key_id TEXT NOT NULL, parent_id TEXT NOT NULL, key_text TEXT NOT NULL, segment TEXT NOT NULL, PRIMARY KEY(namespace, key_id))",
  "CREATE INDEX IF NOT EXISTS storage_nodes_parent ON storage_nodes(namespace, parent_id)",
  "CREATE TABLE IF NOT EXISTS storage_records (namespace TEXT NOT NULL, key_id TEXT NOT NULL, key_text TEXT NOT NULL, body TEXT, revision BIGINT NOT NULL, kind TEXT NOT NULL, scope_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, order_key TEXT NOT NULL, updated BIGINT NOT NULL, PRIMARY KEY(namespace, key_id))",
  "CREATE INDEX IF NOT EXISTS storage_records_session ON storage_records(namespace, session_id, kind, order_key, key_id)",
  "CREATE INDEX IF NOT EXISTS storage_records_scope ON storage_records(namespace, scope_id, kind, updated, key_id)",
  "CREATE INDEX IF NOT EXISTS storage_records_message ON storage_records(namespace, message_id, kind, order_key, key_id)",
  "CREATE INDEX IF NOT EXISTS storage_records_kind ON storage_records(namespace, kind, order_key, key_id)",
  "CREATE TABLE IF NOT EXISTS storage_receipts (namespace TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL, created BIGINT NOT NULL, PRIMARY KEY(namespace, operation_id))",
  "CREATE TABLE IF NOT EXISTS storage_events (namespace TEXT NOT NULL, id TEXT NOT NULL, scope_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, position BIGINT NOT NULL, PRIMARY KEY(namespace, id))",
  "CREATE INDEX IF NOT EXISTS storage_events_pending ON storage_events(namespace, position)",
]

export class StoreTransaction {
  private active = true
  private failure?: unknown
  private readonly connection: SqlConnection
  constructor(
    connection: SqlConnection,
    readonly namespace: string,
    private readonly readonly = false,
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
    return { key, value: JSON.parse(row.body) as T, revision: BigInt(row.revision) }
  }

  async read<T = unknown>(key: string[]): Promise<T> {
    return (await this.versioned<T>(key)).value
  }

  async readMany<T = unknown>(keys: string[][]): Promise<(T | undefined)[]> {
    this.check()
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
        result.push(row?.body ? (JSON.parse(row.body) as T) : undefined)
      }
    }
    return result
  }

  async write<T>(key: string[], value: T, options: { expectedRevision?: bigint } = {}): Promise<void> {
    this.check(true)
    if (key[0] === "sessions" && key.length >= 4) await this.assertNotDeleted([...key.slice(0, 3), "info"])
    await this.put(key, value, options)
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
        encode(value),
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
    await this.connection.query(
      "UPDATE storage_records SET body = NULL, revision = revision + 1, updated = ? WHERE namespace = ? AND key_id = ? AND body IS NOT NULL",
      [Date.now(), this.namespace, keyID(key)],
    )
  }

  // SQLite must drive recursion and record lookups from the frontier, and the liveness probe
  // must resolve storage_records by (namespace, key_id): a joined `body IS NOT NULL` condition
  // makes the planner read the namespace-wide covering index, so even an empty prefix or a
  // single-key subtree costs the whole record set.
  async scan(prefix: string[]): Promise<string[]> {
    this.check()
    const rows = await this.connection.query<SqlRow & { child: string }>(
      "SELECT child.segment AS child FROM storage_nodes child WHERE child.namespace = ? AND child.parent_id = ? AND EXISTS (WITH RECURSIVE tree(key_id) AS (SELECT child.key_id UNION ALL SELECT node.key_id FROM tree CROSS JOIN storage_nodes node WHERE node.namespace = ? AND node.parent_id = tree.key_id) SELECT 1 FROM tree CROSS JOIN storage_records record WHERE record.key_id = tree.key_id AND record.namespace = ? AND record.body IS NOT NULL LIMIT 1)",
      [this.namespace, keyID(prefix), this.namespace, this.namespace],
    )
    return rows.map((row) => row.child).sort()
  }

  async list(prefix: string[]): Promise<string[][]> {
    this.check()
    const rows = await this.connection.query<SqlRow & { key_text: string }>(
      "WITH RECURSIVE tree(key_id) AS (SELECT key_id FROM storage_nodes WHERE namespace = ? AND parent_id = ? UNION ALL SELECT node.key_id FROM tree CROSS JOIN storage_nodes node WHERE node.namespace = ? AND node.parent_id = tree.key_id) SELECT record.key_text FROM tree CROSS JOIN storage_records record WHERE record.key_id = tree.key_id AND record.namespace = ? AND record.body IS NOT NULL",
      [this.namespace, keyID(prefix), this.namespace, this.namespace],
    )
    return rows.map((row) => JSON.parse(row.key_text) as string[]).sort()
  }

  async removeTree(prefix: string[]): Promise<void> {
    this.check(true)
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

  async query<T>(input: RecordQuery): Promise<StoredRecord<T>[]> {
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
    const rows = await this.connection.query<RecordRow>(
      `SELECT key_text, body, revision FROM storage_records WHERE ${conditions.join(" AND ")} ORDER BY order_key ${direction}, key_id ${direction} LIMIT ?`,
      values,
    )
    return rows.map((row) => ({
      key: JSON.parse(row.key_text) as string[],
      value: JSON.parse(row.body!) as T,
      revision: BigInt(row.revision),
    }))
  }

  async *records<T = unknown>(): AsyncGenerator<StoredRecord<T>> {
    let after = ""
    for (;;) {
      this.check()
      const page = await this.connection.query<RecordRow & { key_id: string }>(
        "SELECT key_id, key_text, body, revision FROM storage_records WHERE namespace = ? AND body IS NOT NULL AND key_id > ? ORDER BY key_id LIMIT 256",
        [this.namespace, after],
      )
      if (!page.length) break
      for (const row of page)
        yield {
          key: JSON.parse(row.key_text) as string[],
          value: JSON.parse(row.body!) as T,
          revision: BigInt(row.revision),
        }
      after = page.at(-1)!.key_id
    }
  }

  async *exportEntries(): AsyncGenerator<StorageEntry> {
    for await (const record of this.records())
      yield { type: "record", key: record.key, value: record.value, revision: record.revision.toString() }
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
  private readonly writes = new StorageQueue()
  private readonly owner = randomUUID()
  private closing?: Promise<void>
  private constructor(
    private readonly driver: SqlDriver,
    readonly options: StoreOptions,
  ) {}

  static async open(options: StoreOptions) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.namespace)) throw new StorageIntegrityError("Invalid storage namespace")
    const driver =
      options.backend === "sqlite"
        ? await SqliteDriver.open(options.filename, options.readonly, options.mustExist)
        : await PostgresDriver.open(options.url, options.namespace, options.maxConnections, options.readonly)
    const store = new TransactionalStore(driver, options)
    try {
      await driver.transaction(
        async (connection) => {
          if (!options.readonly) for (const statement of schema) await connection.query(statement)
          const [existing] = await connection.query(
            "SELECT version, owner, state FROM storage_namespaces WHERE namespace = ?",
            [options.namespace],
          )
          if (options.mustExist && !existing) throw new StorageIntegrityError("The active storage namespace is missing")
          if (existing && Number(existing.version) !== 1)
            throw new StorageIntegrityError("Unsupported authoritative storage version")
          if (options.readonly) {
            if (!existing) throw new StorageIntegrityError("Storage namespace does not exist")
            return
          }
          if (existing?.state === "active" && options.backend === "postgres" && !options.recover)
            throw new StorageOwnershipError(
              "The previous PostgreSQL Runtime did not release ownership; verify it has stopped before recovering",
            )
          await connection.query(
            "INSERT INTO storage_namespaces(namespace, version, owner, state) VALUES (?, 1, ?, 'active') ON CONFLICT(namespace) DO UPDATE SET owner = excluded.owner, state = excluded.state",
            [options.namespace, store.owner],
          )
        },
        { readOnly: options.readonly },
      )
      return store
    } catch (error) {
      await driver.close()
      throw error
    }
  }

  private check() {
    if (this.closing) throw new StorageClosedError()
  }

  async snapshot<T>(body: (snapshot: StoreTransaction) => Promise<T>): Promise<T> {
    this.check()
    return this.driver.transaction(
      async (connection) => {
        const snapshot = new StoreTransaction(connection, this.options.namespace, true)
        try {
          const result = await body(snapshot)
          snapshot.assertHealthy()
          return result
        } finally {
          snapshot.finish()
        }
      },
      { readOnly: true },
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
            const tx = new StoreTransaction(connection, this.options.namespace)
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
    return this.snapshot((tx) => tx.read<T>(key))
  }
  versioned<T = unknown>(key: string[]) {
    return this.snapshot((tx) => tx.versioned<T>(key))
  }
  readMany<T = unknown>(keys: string[][]) {
    return this.snapshot((tx) => tx.readMany<T>(keys))
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
    return this.snapshot((tx) => tx.scan(prefix))
  }
  list(prefix: string[]) {
    return this.snapshot((tx) => tx.list(prefix))
  }
  query<T>(input: RecordQuery) {
    return this.snapshot((tx) => tx.query<T>(input))
  }

  async operationReceipt(operationID: string) {
    this.check()
    const [receipt] = await this.driver.query(
      "SELECT request_hash, result FROM storage_receipts WHERE namespace = ? AND operation_id = ?",
      [this.options.namespace, operationID],
    )
    return receipt
      ? { requestHash: String(receipt.request_hash), result: JSON.parse(String(receipt.result)) as unknown }
      : undefined
  }

  async pendingEventCount(): Promise<number> {
    this.check()
    const [row] = await this.driver.query("SELECT COUNT(*) AS count FROM storage_events WHERE namespace = ?", [
      this.options.namespace,
    ])
    return Number(row.count)
  }

  async pendingEvents(limit = 100): Promise<StoredEvent[]> {
    this.check()
    const rows = await this.driver.query(
      "SELECT id, scope_id, type, payload FROM storage_events WHERE namespace = ? ORDER BY position LIMIT ?",
      [this.options.namespace, limit],
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
              const rows = await connection.query("PRAGMA integrity_check", [], { maintenance: true })
              if (rows.length !== 1 || rows[0].integrity_check !== "ok")
                throw new StorageIntegrityError("SQLite integrity verification failed")
            }
            const tx = new StoreTransaction(connection, this.options.namespace, true)
            const issues: Array<{ key: string[]; reason: string }> = []
            const kinds: Record<string, number> = {}
            let records = 0
            try {
              for await (const record of tx.records<Record<string, unknown>>()) {
                records++
                work++
                if (work % 256 === 0) recordProgress(work)
                const meta = metadata(record.key)
                kinds[meta.kind] = (kinds[meta.kind] ?? 0) + 1
                const key = record.key
                if (key[0] !== "sessions") continue
                const parents: string[][] = []
                if (key[3] !== "info") parents.push([...key.slice(0, 3), "info"])
                if (meta.kind === "part") parents.push([...key.slice(0, 5), "info"])
                const values = await tx.readMany(parents)
                for (const [index, parent] of values.entries()) {
                  if (parent === undefined)
                    issues.push({ key, reason: index === 0 ? "missing_session" : "missing_message" })
                }
                if (["session", "message", "part"].includes(meta.kind)) {
                  const expectedID = meta.kind === "part" ? key.at(-1) : key.at(-2)
                  if (!record.value || typeof record.value !== "object" || record.value.id !== expectedID)
                    issues.push({ key, reason: "identity_mismatch" })
                }
              }
              const [invalid] = await connection.query(
                "SELECT COUNT(*) AS count FROM storage_records r LEFT JOIN storage_nodes n ON r.namespace = n.namespace AND r.key_id = n.key_id WHERE r.namespace = ? AND r.body IS NOT NULL AND (n.key_id IS NULL OR n.key_text <> r.key_text OR r.revision < 1)",
                [this.options.namespace],
              )
              if (Number(invalid.count))
                throw new StorageIntegrityError("Logical storage index integrity verification failed")
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
        if (!(error instanceof StorageOwnershipError)) throw error
      } finally {
        await this.driver.close()
      }
    })()
    return this.closing
  }
}
