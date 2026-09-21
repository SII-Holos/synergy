import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { deflateSync } from "node:zlib"
import { initializeSqliteEngine } from "../../src/storage/sqlite-engine"

/**
 * A format 2 store, built from the layout that release actually wrote.
 *
 * The fixture writes real hex keys, real per-level `key_text` node rows and the
 * retired body forms, so the format 3 rewrite is exercised against the shape it
 * has to read rather than against its own output.
 */
const V2_SCHEMA = [
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
  "CREATE INDEX IF NOT EXISTS storage_records_owner ON storage_records(namespace, kind, scope_id, session_id, updated) WHERE body IS NOT NULL",
  "CREATE TABLE IF NOT EXISTS storage_receipts (namespace TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL, created BIGINT NOT NULL, PRIMARY KEY(namespace, operation_id))",
  "CREATE TABLE IF NOT EXISTS storage_events (namespace TEXT NOT NULL, id TEXT NOT NULL, scope_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, position BIGINT NOT NULL, PRIMARY KEY(namespace, id))",
  "CREATE INDEX IF NOT EXISTS storage_events_pending ON storage_events(namespace, position)",
]

export type V2Record = {
  key: string[]
  /** Plain JSON, the retired `z:` base64 form, or absent for a tombstone. */
  body?: string | null
  kind?: string
  updated?: number
}

/**
 * The indexed columns the write path derives for a key.
 *
 * Mirrors the store's own `metadata()`: the fixture must place the same
 * `kind`/owner/order values a release writer produced, or a comparison between a
 * migrated store and a native one would be comparing the fixture's guess at the
 * ordering to the writer's real one.
 */
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

export function keyHex(key: readonly string[]) {
  return createHash("sha256").update(JSON.stringify(key)).digest("hex")
}

/** A compressible body large enough that the current codec stores it as a frame. */
export function compressible(text = "durable rollout evidence"): string {
  return JSON.stringify({ text: text.repeat(200) })
}

/** The retired base64 deflate form, which is what an old writer left behind. */
export function legacyBody(value: unknown): string {
  return "z:" + deflateSync(JSON.stringify(value), { level: 1 }).toString("base64")
}

export function createV2Store(options: {
  filename: string
  namespace: string
  records: V2Record[]
  artifacts?: Array<{ key: string[]; pack: string }>
  /**
   * Records incremental auto-vacuum in the header before any table exists.
   *
   * An authoritative store converts to incremental mode through the
   * `20260918-storage-incremental-vacuum` migration, which is the shape a
   * capacity measurement has to reproduce: with auto-vacuum off, pages the
   * rewrite frees stay on the freelist and the file cannot shrink. SQLite only
   * honours the pragma on an empty database, so it must run before the schema.
   */
  incrementalVacuum?: boolean
}) {
  initializeSqliteEngine()
  const database = new Database(options.filename, { create: true, strict: true })
  try {
    if (options.incrementalVacuum) {
      database.run("PRAGMA auto_vacuum = INCREMENTAL")
      database.run("PRAGMA journal_mode = WAL")
    }
    database.exec(V2_SCHEMA.join(";\n"))
    database
      .query("INSERT INTO storage_namespaces(namespace, version, owner, state) VALUES (?, 2, '', 'idle')")
      .run(options.namespace)
    for (const record of options.records) {
      for (let depth = 1; depth <= record.key.length; depth++) {
        const prefix = record.key.slice(0, depth)
        database
          .query(
            "INSERT OR IGNORE INTO storage_nodes(namespace, key_id, parent_id, key_text, segment) VALUES (?, ?, ?, ?, ?)",
          )
          .run(options.namespace, keyHex(prefix), keyHex(prefix.slice(0, -1)), JSON.stringify(prefix), prefix.at(-1)!)
      }
      const meta = metadata(record.key)
      database
        .query(
          "INSERT OR REPLACE INTO storage_records(namespace, key_id, key_text, body, revision, kind, scope_id, session_id, message_id, order_key, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          options.namespace,
          keyHex(record.key),
          JSON.stringify(record.key),
          record.body === undefined ? JSON.stringify({ v: 1 }) : record.body,
          1,
          meta.kind,
          meta.scope,
          meta.session,
          meta.message,
          meta.order,
          record.updated ?? 1,
        )
    }
    for (const artifact of options.artifacts ?? [])
      database
        .query(
          "INSERT OR REPLACE INTO storage_artifacts(namespace, key_text, owner_key, location, pack) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          options.namespace,
          JSON.stringify(artifact.key),
          JSON.stringify(artifact.key.slice(0, 1)),
          JSON.stringify({
            pack: artifact.pack,
            blockOffset: 0,
            blockBytes: 1,
            decodedBytes: 1,
            offset: 0,
            size: 1,
            codec: "raw",
            sha256: "0".repeat(64),
          }),
          artifact.pack,
        )
  } finally {
    database.close()
  }
}

export function inspect(filename: string, namespace: string) {
  initializeSqliteEngine()
  const database = new Database(filename, { readonly: true, strict: true })
  const rows = <T>(statement: string, values: (string | number)[] = []) => {
    const query = database.query<T, (string | number)[]>(statement)
    try {
      return query.all(...values)
    } finally {
      query.finalize()
    }
  }
  return {
    version: () =>
      Number(
        rows<{ version: number }>("SELECT version FROM storage_namespaces WHERE namespace = ?", [namespace])[0]!
          .version,
      ),
    keyColumn: () =>
      rows<{ storage: string }>("SELECT typeof(key_id) AS storage FROM storage_records WHERE namespace = ? LIMIT 1", [
        namespace,
      ])[0]?.storage,
    recordKeys: () =>
      rows<{ key_id: string | Uint8Array; key_text: string }>(
        "SELECT key_id, key_text FROM storage_records WHERE namespace = ? AND body IS NOT NULL",
        [namespace],
      ),
    nodeColumns: () =>
      rows<{ name: string }>("SELECT name FROM pragma_table_info('storage_nodes') WHERE name = 'key_text'"),
    messageIndex: () =>
      rows<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'storage_records_message'")[0]?.sql,
    artifactPackColumn: () =>
      rows<{ name: string; hidden: number }>(
        "SELECT name, hidden FROM pragma_table_xinfo('storage_artifacts') WHERE name = 'pack'",
      )[0],
    close: () => database.close(),
  }
}
