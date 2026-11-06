import { TextSearch } from "../util/text-search"
import type { SqlConnection, SqlRow, SqlValue } from "./sql-contract"
import { StorageIntegrityError } from "./errors"

export type TextCategory = "text" | "reasoning" | "tool"
export interface TextProjectionState {
  revision: bigint
  version: string
  progress: number
  ready: boolean
  lexical?: { version: string; progress: number; ready: boolean }
}
export interface TextProjectionAppend {
  key: string[]
  revision: bigint
  version: string
  category: TextCategory
  offset: number
  fragments: { offset: number; text: string }[]
  complete: boolean
}
export interface TextProjectionQuery {
  scopeID?: string
  sessionID?: string
  query: string
  terms?: string[]
  categories?: TextCategory[]
  cursor?: string
  limit?: number
}
export interface TextProjectionHit {
  key: string[]
  cursor: string
  revision: string
  version: string
  category: TextCategory
  offset: number
  text: string
  score?: number
}

// Provenance: https://www.sqlite.org/fts5.html#the_trigram_tokenizer
// Local adaptation: overlap bounded text fragments for substring matches; short queries retain cursor-based scans.
export const LEXICAL_VERSION = "1"
export const TEXT_FRAGMENT_CHARS = TextSearch.fragmentCharacters
export const TEXT_QUERY_CHARS = TextSearch.queryCharacters
const normalize = (text: string) => text.normalize("NFC").toLowerCase()

export function textProjectionSchema(backend: "sqlite" | "postgres") {
  const key = backend === "sqlite" ? "BLOB" : "TEXT"
  return [
    `CREATE TABLE IF NOT EXISTS storage_text_sources (namespace TEXT NOT NULL, source_key ${key} NOT NULL, source_revision BIGINT NOT NULL, source_version TEXT NOT NULL, category TEXT NOT NULL, progress INTEGER NOT NULL, ready INTEGER NOT NULL, PRIMARY KEY(namespace, source_key))`,
    `CREATE TABLE IF NOT EXISTS storage_text_chunks (id ${backend === "sqlite" ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "BIGSERIAL PRIMARY KEY"}, namespace TEXT NOT NULL, source_key ${key} NOT NULL, source_revision BIGINT NOT NULL, source_version TEXT NOT NULL, category TEXT NOT NULL, ordinal INTEGER NOT NULL, source_offset INTEGER NOT NULL, text TEXT NOT NULL, normalized TEXT NOT NULL, UNIQUE(namespace, source_key, source_revision, ordinal))`,
    "CREATE INDEX IF NOT EXISTS storage_text_chunks_source ON storage_text_chunks(namespace, source_key, source_revision)",
    `CREATE TABLE IF NOT EXISTS storage_text_lexical_sources (namespace TEXT NOT NULL, source_key ${key} NOT NULL, source_revision BIGINT NOT NULL, version TEXT NOT NULL, progress INTEGER NOT NULL, ready INTEGER NOT NULL, PRIMARY KEY(namespace, source_key), FOREIGN KEY(namespace, source_key) REFERENCES storage_text_sources(namespace, source_key) ON DELETE CASCADE)`,
    "CREATE TABLE IF NOT EXISTS storage_text_terms (namespace TEXT NOT NULL, term TEXT NOT NULL, chunk_id BIGINT NOT NULL REFERENCES storage_text_chunks(id) ON DELETE CASCADE, PRIMARY KEY(namespace, term, chunk_id))",
    "CREATE INDEX IF NOT EXISTS storage_text_terms_chunk ON storage_text_terms(chunk_id)",
    `CREATE TABLE IF NOT EXISTS storage_text_gc (namespace TEXT NOT NULL, source_key ${key} NOT NULL, PRIMARY KEY(namespace, source_key))`,
    ...(backend === "sqlite"
      ? [
          "CREATE VIRTUAL TABLE IF NOT EXISTS storage_text_fts USING fts5(normalized, content='storage_text_chunks', content_rowid='id', tokenize='trigram')",
          "CREATE TRIGGER IF NOT EXISTS storage_text_insert AFTER INSERT ON storage_text_chunks BEGIN INSERT INTO storage_text_fts(rowid, normalized) VALUES (NEW.id, NEW.normalized); END",
          "CREATE TRIGGER IF NOT EXISTS storage_text_delete AFTER DELETE ON storage_text_chunks BEGIN INSERT INTO storage_text_fts(storage_text_fts, rowid, normalized) VALUES ('delete', OLD.id, OLD.normalized); END",
          "CREATE TRIGGER IF NOT EXISTS storage_text_update AFTER UPDATE ON storage_text_chunks BEGIN INSERT INTO storage_text_fts(storage_text_fts, rowid, normalized) VALUES ('delete', OLD.id, OLD.normalized); INSERT INTO storage_text_fts(rowid, normalized) VALUES (NEW.id, NEW.normalized); END",
          "CREATE TRIGGER IF NOT EXISTS storage_text_source_changed AFTER UPDATE OF revision ON storage_records WHEN EXISTS(SELECT 1 FROM storage_text_sources WHERE namespace = OLD.namespace AND source_key = OLD.key_id) BEGIN INSERT INTO storage_text_gc(namespace, source_key) VALUES(OLD.namespace, OLD.key_id) ON CONFLICT(namespace, source_key) DO NOTHING; END",
          "CREATE TRIGGER IF NOT EXISTS storage_text_source_deleted AFTER DELETE ON storage_records WHEN EXISTS(SELECT 1 FROM storage_text_sources WHERE namespace = OLD.namespace AND source_key = OLD.key_id) BEGIN INSERT INTO storage_text_gc(namespace, source_key) VALUES(OLD.namespace, OLD.key_id) ON CONFLICT(namespace, source_key) DO NOTHING; END",
        ]
      : [
          "CREATE OR REPLACE FUNCTION storage_text_source_gc() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM storage_text_sources WHERE namespace = OLD.namespace AND source_key = OLD.key_id) THEN INSERT INTO storage_text_gc(namespace, source_key) VALUES(OLD.namespace, OLD.key_id) ON CONFLICT(namespace, source_key) DO NOTHING; END IF; RETURN NULL; END $$",
          "CREATE OR REPLACE TRIGGER storage_text_source_changed AFTER UPDATE OF revision OR DELETE ON storage_records FOR EACH ROW EXECUTE FUNCTION storage_text_source_gc()",
        ]),
  ]
}

export class TextProjection {
  constructor(
    private readonly connection: SqlConnection,
    private readonly namespace: string,
    private readonly backend: "sqlite" | "postgres",
    private readonly key: (key: string[]) => SqlValue,
  ) {}

  async collect() {
    const [owner] = await this.connection.query(
      "SELECT source_key FROM storage_text_gc WHERE namespace = ? ORDER BY source_key LIMIT 1",
      [this.namespace],
    )
    if (!owner) return { ready: true, removed: 0 }
    const invalid =
      "NOT EXISTS(SELECT 1 FROM storage_records r WHERE r.namespace = c.namespace AND r.key_id = c.source_key AND r.revision = c.source_revision AND r.body IS NOT NULL)"
    const dropped = await this.connection.query(
      `DELETE FROM storage_text_chunks WHERE id IN (SELECT c.id FROM storage_text_chunks c WHERE c.namespace = ? AND c.source_key = ? AND ${invalid} ORDER BY c.id LIMIT 4) RETURNING id`,
      [this.namespace, owner.source_key],
    )
    await this.connection.query(
      "DELETE FROM storage_text_sources WHERE namespace = ? AND source_key = ? AND NOT EXISTS(SELECT 1 FROM storage_records r WHERE r.namespace = storage_text_sources.namespace AND r.key_id = storage_text_sources.source_key AND r.revision = storage_text_sources.source_revision AND r.body IS NOT NULL)",
      [this.namespace, owner.source_key],
    )
    const [remaining] = await this.connection.query(
      `SELECT 1 FROM storage_text_chunks c WHERE c.namespace = ? AND c.source_key = ? AND ${invalid} LIMIT 1`,
      [this.namespace, owner.source_key],
    )
    if (!remaining)
      await this.connection.query("DELETE FROM storage_text_gc WHERE namespace = ? AND source_key = ?", [
        this.namespace,
        owner.source_key,
      ])
    return { ready: false, removed: dropped.length }
  }

  async state(key: string[]): Promise<TextProjectionState | undefined> {
    const [row] = await this.connection.query(
      "SELECT s.source_revision, s.source_version, s.progress, s.ready, l.version AS lexical_version, l.progress AS lexical_progress, l.ready AS lexical_ready FROM storage_text_sources s LEFT JOIN storage_text_lexical_sources l ON l.namespace = s.namespace AND l.source_key = s.source_key AND l.source_revision = s.source_revision WHERE s.namespace = ? AND s.source_key = ?",
      [this.namespace, this.key(key)],
    )
    return (
      row && {
        revision: BigInt(row.source_revision as bigint),
        version: String(row.source_version),
        progress: Number(row.progress),
        ready: Boolean(Number(row.ready)),
        lexical:
          row.lexical_version === null
            ? undefined
            : {
                version: String(row.lexical_version),
                progress: Number(row.lexical_progress),
                ready: Boolean(Number(row.lexical_ready)),
              },
      }
    )
  }

  async append(input: TextProjectionAppend) {
    if (
      input.fragments.length > 4 ||
      input.fragments.some((item) => item.text.length > TEXT_FRAGMENT_CHARS + TEXT_QUERY_CHARS * 2) ||
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0
    )
      throw new StorageIntegrityError("Text projection batch exceeds its budget")
    const key = this.key(input.key)
    const [record] = await this.connection.query(
      "SELECT revision FROM storage_records WHERE namespace = ? AND key_id = ? AND body IS NOT NULL",
      [this.namespace, key],
    )
    if (!record || BigInt(record.revision as bigint) !== input.revision) return false
    const previous = await this.state(input.key)
    const current = previous?.revision === input.revision && previous.version === input.version
    const lexical = current && previous.lexical?.version === LEXICAL_VERSION ? previous.lexical : undefined
    if (current && ((previous.ready && lexical?.ready) || (lexical?.progress ?? 0) !== input.offset)) return false
    if (!current && input.offset !== 0) return false
    if (!current)
      await this.connection.query(
        "INSERT INTO storage_text_sources(namespace, source_key, source_revision, source_version, category, progress, ready) VALUES (?, ?, ?, ?, ?, 0, 0) ON CONFLICT(namespace, source_key) DO UPDATE SET source_revision = excluded.source_revision, source_version = excluded.source_version, category = excluded.category, progress = 0, ready = 0",
        [this.namespace, key, input.revision, input.version, input.category],
      )
    if (input.fragments.length) {
      const chunks = await this.connection.query(
        `INSERT INTO storage_text_chunks(namespace, source_key, source_revision, source_version, category, ordinal, source_offset, text, normalized) VALUES ${input.fragments.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",")} ON CONFLICT(namespace, source_key, source_revision, ordinal) DO UPDATE SET source_version = excluded.source_version, category = excluded.category, source_offset = excluded.source_offset, text = excluded.text, normalized = excluded.normalized RETURNING id, ordinal`,
        input.fragments.flatMap((fragment, index) => [
          this.namespace,
          key,
          input.revision,
          input.version,
          input.category,
          input.offset + index,
          fragment.offset,
          fragment.text,
          normalize(fragment.text),
        ]),
      )
      for (const chunk of chunks) {
        const fragment = input.fragments[Number(chunk.ordinal) - input.offset]!
        const terms = [...new Set(TextSearch.tokenize(fragment.text))]
        await this.connection.query("DELETE FROM storage_text_terms WHERE chunk_id = ?", [chunk.id])
        for (let start = 0; start < terms.length; start += 256) {
          const batch = terms.slice(start, start + 256)
          await this.connection.query(
            `INSERT INTO storage_text_terms(namespace, term, chunk_id) VALUES ${batch.map(() => "(?, ?, ?)").join(",")}`,
            batch.flatMap((term) => [this.namespace, term, chunk.id]),
          )
        }
      }
    }
    await this.connection.query(
      "INSERT INTO storage_text_lexical_sources(namespace, source_key, source_revision, version, progress, ready) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(namespace, source_key) DO UPDATE SET source_revision = excluded.source_revision, version = excluded.version, progress = excluded.progress, ready = excluded.ready",
      [
        this.namespace,
        key,
        input.revision,
        LEXICAL_VERSION,
        input.offset + input.fragments.length,
        Number(input.complete),
      ],
    )
    await this.connection.query(
      "UPDATE storage_text_sources SET progress = ?, ready = ? WHERE namespace = ? AND source_key = ?",
      [
        Math.max(input.offset + input.fragments.length, current ? previous.progress : 0),
        Number(input.complete || (current && previous.ready)),
        this.namespace,
        key,
      ],
    )
    await this.connection.query(
      "DELETE FROM storage_text_chunks WHERE id IN (SELECT id FROM storage_text_chunks WHERE namespace = ? AND source_key = ? AND source_revision <> ? ORDER BY id LIMIT 4)",
      [this.namespace, key, input.revision],
    )
    return true
  }

  private async ranked(input: TextProjectionQuery) {
    const terms = [...new Set(input.terms!.flatMap(TextSearch.tokenize))]
    const categories = input.categories ?? ["text"]
    if (!terms.length || !categories.length) return { items: [], nextCursor: null, scanned: 0, indexed: true }
    if (terms.length > 32 || terms.some((term) => [...term].length > TEXT_QUERY_CHARS))
      throw new StorageIntegrityError("Search query exceeds its budget")
    const cursor = input.cursor?.match(/^(\d+):([A-Za-z0-9_-]+)$/)
    if (input.cursor && !cursor) throw new StorageIntegrityError("Invalid text search cursor")
    const limit = Math.max(1, Math.min(100, input.limit ?? 50))
    const conditions = [
      "t.namespace = ?",
      `t.term IN (${terms.map(() => "?").join(",")})`,
      "s.ready = 1",
      "l.ready = 1",
      "l.version = ?",
      "l.source_revision = s.source_revision",
      "s.source_revision = c.source_revision",
      "s.source_version = c.source_version",
      "r.revision = s.source_revision",
      "r.body IS NOT NULL",
      `c.category IN (${categories.map(() => "?").join(",")})`,
    ]
    const values: SqlValue[] = [this.namespace, ...terms, LEXICAL_VERSION, ...categories]
    for (const [column, value] of [
      ["r.scope_id", input.scopeID],
      ["r.session_id", input.sessionID],
    ] as const) {
      if (!value) continue
      conditions.push(`${column} = ?`)
      values.push(value)
    }
    const after = cursor ? "WHERE (matched.score < ? OR (matched.score = ? AND matched.identity < ?))" : ""
    if (cursor) values.push(Number(cursor[1]), Number(cursor[1]), Buffer.from(cursor[2]!, "base64url").toString())
    values.push(limit + 1)
    const rows = await this.connection.query<SqlRow>(
      `WITH matched AS (
        SELECT MIN(c.id) AS id, COUNT(DISTINCT t.term) AS score, r.scope_id || '/' || r.session_id || '/' || r.message_id AS identity
        FROM storage_text_terms t JOIN storage_text_chunks c ON c.id = t.chunk_id
        JOIN storage_text_sources s ON s.namespace = c.namespace AND s.source_key = c.source_key
        JOIN storage_text_lexical_sources l ON l.namespace = s.namespace AND l.source_key = s.source_key
        JOIN storage_records r ON r.namespace = s.namespace AND r.key_id = s.source_key
        WHERE ${conditions.join(" AND ")} GROUP BY r.scope_id, r.session_id, r.message_id
      ) SELECT c.id, c.source_revision, c.source_version, c.category, c.source_offset, c.text, r.key_text, matched.score, matched.identity
       FROM matched JOIN storage_text_chunks c ON c.id = matched.id
       JOIN storage_records r ON r.namespace = c.namespace AND r.key_id = c.source_key
       ${after} ORDER BY matched.score DESC, matched.identity DESC LIMIT ?`,
      values,
    )
    const position = (row: SqlRow) => `${row.score}:${Buffer.from(String(row.identity)).toString("base64url")}`
    const page = rows.slice(0, limit)
    const items: TextProjectionHit[] = page.map((row) => ({
      key: JSON.parse(String(row.key_text)) as string[],
      cursor: position(row),
      revision: String(row.source_revision),
      version: String(row.source_version),
      category: String(row.category) as TextCategory,
      offset: Number(row.source_offset),
      text: String(row.text),
      score: Number(row.score),
    }))
    return {
      items,
      nextCursor: rows.length > limit ? position(page.at(-1)!) : null,
      scanned: page.length,
      indexed: true,
    }
  }

  async search(
    input: TextProjectionQuery,
  ): Promise<{ items: TextProjectionHit[]; nextCursor: string | null; scanned: number; indexed: boolean }> {
    if (input.terms) return this.ranked(input)
    const terms = [...new Set([input.query].map(normalize).filter(Boolean))]
    const query = terms[0] ?? ""
    const categories = input.categories ?? ["text"]
    if (!query || !categories.length) return { items: [], nextCursor: null, scanned: 0, indexed: false }
    if (terms.length > 32 || terms.some((term) => [...term].length > TEXT_QUERY_CHARS))
      throw new StorageIntegrityError("Search query exceeds its budget")
    if (input.cursor && !/^\d+$/.test(input.cursor)) throw new StorageIntegrityError("Invalid text search cursor")
    const indexed = this.backend === "sqlite" && terms.every((term) => [...term].length >= 3)
    const limit = indexed ? Math.max(1, Math.min(100, input.limit ?? 50)) : 32
    const conditions = [
      "c.namespace = ?",
      "s.ready = 1",
      "s.source_revision = c.source_revision",
      "s.source_version = c.source_version",
      "r.revision = s.source_revision",
      "r.body IS NOT NULL",
      `c.category IN (${categories.map(() => "?").join(",")})`,
    ]
    const values: SqlValue[] = [this.namespace, ...categories]
    if (input.scopeID) {
      conditions.push("r.scope_id = ?")
      values.push(input.scopeID)
    }
    if (input.sessionID) {
      conditions.push("r.session_id = ?")
      values.push(input.sessionID)
    }
    if (input.cursor) {
      conditions.push("c.id > ?")
      values.push(BigInt(input.cursor))
    }
    if (indexed) {
      conditions.push("storage_text_fts MATCH ?")
      values.push(terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR "))
    }
    values.push(limit + 1)
    const rows = await this.connection.query<SqlRow>(
      `SELECT c.id, c.source_revision, c.source_version, c.category, c.source_offset, c.text, c.normalized, r.key_text FROM ${indexed ? "storage_text_fts JOIN storage_text_chunks c ON c.id = storage_text_fts.rowid" : "storage_text_chunks c"} JOIN storage_text_sources s ON s.namespace = c.namespace AND s.source_key = c.source_key JOIN storage_records r ON r.namespace = s.namespace AND r.key_id = s.source_key WHERE ${conditions.join(" AND ")} ORDER BY c.id LIMIT ?`,
      values,
    )
    const scanned = rows.slice(0, limit)
    const items: TextProjectionHit[] = []
    const seen = new Set<string>()
    for (const row of scanned) {
      const matched = terms
        .map((term) => ({ term, at: String(row.normalized).indexOf(term) }))
        .find((match) => match.at >= 0)
      const at = matched?.at ?? -1
      if (at < 0 || seen.has(String(row.key_text))) continue
      seen.add(String(row.key_text))
      const text = String(row.text)
      const start = Math.max(0, at - 80)
      items.push({
        key: JSON.parse(String(row.key_text)) as string[],
        cursor: String(row.id),
        revision: String(row.source_revision),
        version: String(row.source_version),
        category: String(row.category) as TextCategory,
        offset: Number(row.source_offset) + at,
        text: text.slice(start, Math.min(text.length, at + (matched?.term.length ?? 0) + 140)),
      })
    }
    return {
      items,
      nextCursor: rows.length > limit ? String(scanned.at(-1)!.id) : null,
      scanned: scanned.length,
      indexed,
    }
  }
}
