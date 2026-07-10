import { Database, type SQLQueryBindings } from "bun:sqlite"
import * as sqliteVec from "sqlite-vec"
import { Global } from "../global"
import { Log } from "../util/log"
import type { Embedding } from "../vector/embedding"
import { existsSync, realpathSync } from "fs"
import path from "path"

import { PerformanceIssues } from "@/performance/issues"
import { PerformanceMetrics } from "@/performance/metrics"
const log = Log.create({ service: "library.db" })

let db: Database | undefined

let embeddingDimensions: number | undefined
interface VecTableState {
  ready: boolean
  failAt: number | undefined
  tableName: string
  dimensions: number | undefined
  expectedDimensions: number | undefined
}

const vecExperience: VecTableState = {
  ready: false,
  failAt: undefined,
  tableName: "vec_experience",
  dimensions: undefined,
  expectedDimensions: undefined,
}
const vecMemory: VecTableState = {
  ready: false,
  failAt: undefined,
  tableName: "vec_memory",
  dimensions: undefined,
  expectedDimensions: undefined,
}

const VEC_RETRY_MS = 60_000

function tryRecoverVec(state: VecTableState): boolean {
  if (!state.failAt) return state.ready
  const elapsed = Date.now() - state.failAt
  if (elapsed <= VEC_RETRY_MS) return false
  const conn = open()
  refreshVecTableState(conn, state, state.expectedDimensions)
  if (state.ready) state.failAt = undefined
  return state.ready
}

function safeVecOp<T>(state: VecTableState, fn: () => T, fallback: T): T {
  if (state.failAt && !tryRecoverVec(state)) return fallback
  if (!state.ready) return fallback
  try {
    return fn()
  } catch (e) {
    state.ready = false
    state.failAt = Date.now()
    log.warn(`${state.tableName} operation failed, disabling vector search`, {
      error: e,
    })
    return fallback
  }
}

const MEMORY_CATEGORIES = [
  "user",
  "self",
  "relationship",
  "interaction",
  "workflow",
  "coding",
  "writing",
  "asset",
  "insight",
  "knowledge",
  "personal",
  "general",
] as const

const MEMORY_RECALL_MODES = ["always", "contextual", "search_only"] as const

type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]
type MemoryRecallMode = (typeof MEMORY_RECALL_MODES)[number]

const HOMEBREW_SQLITE_PATHS = [
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
]

function setupCustomSQLite() {
  if (process.platform !== "darwin") return
  for (const p of HOMEBREW_SQLITE_PATHS) {
    if (existsSync(p)) {
      try {
        Database.setCustomSQLite(p)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes("SQLite already loaded") || message.includes("exactly once")) {
          log.debug("custom sqlite already initialized", { path: p })
          return
        }
        throw err
      }
      log.info("using custom sqlite", { path: p })
      return
    }
  }
  log.warn("no homebrew sqlite found, extension loading may fail on macOS")
}

setupCustomSQLite()

function loadSqliteVec(conn: Database) {
  const suffix = process.platform === "win32" ? "dll" : process.platform === "darwin" ? "dylib" : "so"

  // Compiled binary: look for vec0 next to the executable
  try {
    const execDir = path.dirname(realpathSync(process.execPath))
    const fromExec = path.resolve(execDir, "..", `vec0.${suffix}`)
    if (existsSync(fromExec)) {
      conn.loadExtension(fromExec)
      log.info("sqlite-vec loaded", { source: "binary", path: fromExec })
      return
    }
  } catch {}

  // Dev mode: use npm package resolution
  sqliteVec.load(conn)
  log.info("sqlite-vec loaded", { source: "npm" })
}

function open(): Database {
  if (db) return db
  const dbPath = Global.Path.libraryDB
  log.info("open", { path: dbPath })
  const conn = new Database(dbPath, { create: true })
  try {
    loadSqliteVec(conn)
  } catch (e) {
    log.warn("sqlite-vec extension failed to load, vector search will be unavailable", {
      error: e,
    })
  }
  conn.exec("PRAGMA journal_mode=WAL")
  conn.exec("PRAGMA busy_timeout=5000")
  conn.exec("PRAGMA foreign_keys=ON")
  initialize(conn)
  db = instrumentConnection(conn)

  // Periodic WAL checkpoint to prevent unbounded WAL file growth.
  // TRUNCATE checkpoints and zeros the WAL file; failures are non-critical.
  const checkpointTimer = setInterval(
    () => {
      try {
        conn.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      } catch {}
    },
    5 * 60 * 1000,
  )
  checkpointTimer.unref()

  return db
}

function instrumentConnection(conn: Database): Database {
  const originalPrepare = conn.prepare.bind(conn)
  conn.prepare = ((sql: string, ...args: unknown[]) => {
    const statement = originalPrepare(sql, ...(args as []))
    const operation = librarySqlOperation(sql)
    const statementRecord = statement as unknown as Record<string, (...bindings: SQLQueryBindings[]) => unknown>
    for (const method of ["run", "get", "all"] as const) {
      const original = statementRecord[method]?.bind(statement)
      if (!original) continue
      statementRecord[method] = (...bindings: SQLQueryBindings[]) => {
        const start = performance.now()
        let status = "ok"
        try {
          return original(...bindings)
        } catch (error) {
          status = "error"
          PerformanceMetrics.record({
            name: "library.sqlite.query.error",
            value: 1,
            unit: "count",
            module: "library",
            labels: { operation, method, errorName: error instanceof Error ? error.name : "unknown" },
          })
          PerformanceIssues.raise({
            code: "PERF_LIBRARY_QUERY_ERROR",
            severity: "warning",
            module: "library",
            title: "Library query failed",
            message: `${operation} ${method} failed`,
            evidence: { operation, method, errorName: error instanceof Error ? error.name : "unknown" },
          })
          throw error
        } finally {
          PerformanceMetrics.record({
            name: "library.sqlite.query.duration",
            value: performance.now() - start,
            unit: "ms",
            module: "library",
            labels: { operation, method, status },
          })
        }
      }
    }
    return statement
  }) as typeof conn.prepare
  return conn
}

function librarySqlOperation(sql: string) {
  const normalized = sql.trim().replace(/\s+/g, " ").toLowerCase()
  const verb = normalized.split(" ", 1)[0] ?? "query"
  if (
    normalized.includes(" from memory") ||
    normalized.includes(" into memory") ||
    normalized.includes(" update memory")
  ) {
    return `${verb}.memory`
  }
  if (
    normalized.includes(" from experience") ||
    normalized.includes(" into experience") ||
    normalized.includes(" update experience")
  ) {
    return `${verb}.experience`
  }
  if (normalized.includes("vec_memory")) return `${verb}.vec_memory`
  if (normalized.includes("vec_experience")) return `${verb}.vec_experience`
  return verb
}

function hasVecTable(conn: Database, name: string): boolean {
  const row = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1").get(name)
  return row !== undefined
}

function getVecTableSQL(conn: Database, name: string): string | null {
  const row = conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1").get(name) as {
    sql: string | null
  } | null
  return row?.sql ?? null
}

function parseVecTableDimensions(sql: string | null): number | undefined {
  if (!sql) return undefined
  const dimensions = [...sql.matchAll(/\bfloat\s*\[\s*(\d+)\s*\]/gi)].map((match) => Number(match[1]))
  if (dimensions.length === 0) return undefined
  const unique = new Set(dimensions)
  if (unique.size !== 1) return undefined
  return dimensions[0]
}

function getVecTableDimensions(conn: Database, name: string): number | undefined {
  return parseVecTableDimensions(getVecTableSQL(conn, name))
}

function refreshVecTableState(conn: Database, state: VecTableState, expectedDimensions?: number): VecTableState {
  state.expectedDimensions = expectedDimensions
  state.dimensions = getVecTableDimensions(conn, state.tableName)
  state.ready =
    state.dimensions !== undefined &&
    (state.expectedDimensions === undefined || state.dimensions === state.expectedDimensions)
  return state
}

function vecTableRowCount(conn: Database, name: string): number | null {
  if (!hasVecTable(conn, name)) return null
  try {
    const row = conn.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get() as { count: number }
    return row.count
  } catch {
    return null
  }
}

function initialize(conn: Database) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL,
      embedding_dimensions INTEGER
    )
  `)

  const row = conn.prepare("SELECT version, embedding_dimensions FROM schema_version LIMIT 1").get() as {
    version: number
    embedding_dimensions: number | null
  } | null

  if (!row) {
    conn.prepare("INSERT INTO schema_version (version, embedding_dimensions) VALUES (?1, NULL)").run(1)
  } else if (row.embedding_dimensions) {
    embeddingDimensions = row.embedding_dimensions
  }

  refreshVecTableState(conn, vecExperience, embeddingDimensions)
  refreshVecTableState(conn, vecMemory, embeddingDimensions)
  // Ensure vec tables are re-initialized on every connection open — not just
  // during data insertion. sqlite-vec's vec0 module may need per-connection
  // CREATE TABLE registration for internal data structures.
  // Use the dimensions discovered by refreshVecTableState (from sqlite_master),
  // not embeddingDimensions (which closeDB() resets to undefined).
  if (vecExperience.dimensions !== undefined) {
    try {
      conn.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_experience USING vec0(
          experience_id TEXT PRIMARY KEY,
          scope_id TEXT partition key,
          reward_status TEXT,
          intent_embedding float[${vecExperience.dimensions}] distance_metric=cosine,
          script_embedding float[${vecExperience.dimensions}] distance_metric=cosine
        )
      `)
      refreshVecTableState(conn, vecExperience, embeddingDimensions)
      if (vecExperience.ready) vecExperience.failAt = undefined
    } catch (e) {
      log.warn("vec_experience re-initialization failed", { error: e })
    }
  }
  if (vecMemory.dimensions !== undefined) {
    try {
      conn.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(
          memory_id TEXT PRIMARY KEY,
          category TEXT,
          embedding float[${vecMemory.dimensions}] distance_metric=cosine
        )
      `)
      refreshVecTableState(conn, vecMemory, embeddingDimensions)
      if (vecMemory.ready) vecMemory.failAt = undefined
    } catch (e) {
      log.warn("vec_memory re-initialization failed", { error: e })
    }
  }

  conn.exec(`
    CREATE TABLE IF NOT EXISTS experience (
      id                       TEXT PRIMARY KEY,
      session_id               TEXT NOT NULL,
      scope_id                 TEXT NOT NULL,
      intent                   TEXT NOT NULL,
      intent_embedding_model   TEXT,
      script_embedding_model   TEXT,
      source_provider_id       TEXT,
      source_model_id          TEXT,
      reward                   REAL,
      rewards                  TEXT NOT NULL DEFAULT '{}',
      q_values                 TEXT NOT NULL DEFAULT '{}',
      q_visits                 INTEGER NOT NULL DEFAULT 0,
      q_updated_at             INTEGER,
      q_history                TEXT NOT NULL DEFAULT '[]',
      retrieved_experience_ids TEXT NOT NULL DEFAULT '[]',
      reward_status            TEXT NOT NULL DEFAULT 'evaluated',
      turns_remaining          INTEGER,
      created_at               INTEGER NOT NULL,
      updated_at               INTEGER NOT NULL
    )
  `)

  conn.exec(`
    CREATE TABLE IF NOT EXISTS experience_content (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      scope_id   TEXT NOT NULL,
      script     TEXT,
      raw        TEXT,
      metadata   TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  conn.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      content         TEXT NOT NULL,
      category        TEXT NOT NULL DEFAULT 'general',
      recall_mode     TEXT NOT NULL DEFAULT 'search_only',
      embedding_model TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    )
  `)

  conn.exec("CREATE INDEX IF NOT EXISTS idx_experience_scope ON experience(scope_id)")
  conn.exec("CREATE INDEX IF NOT EXISTS idx_experience_session ON experience(session_id)")
  conn.exec("CREATE INDEX IF NOT EXISTS idx_experience_content_scope ON experience_content(scope_id)")
  conn.exec("CREATE INDEX IF NOT EXISTS idx_experience_content_session ON experience_content(session_id)")
  conn.exec("CREATE INDEX IF NOT EXISTS idx_memory_category ON memory(category, created_at)")
  conn.exec("CREATE INDEX IF NOT EXISTS idx_memory_recall_mode ON memory(recall_mode)")

  log.info("schema ready")
}

function ensureExperienceVecTable(dimensions: number) {
  const conn = open()
  refreshVecTableState(conn, vecExperience, dimensions)
  if (vecExperience.ready && vecExperience.dimensions === dimensions) return

  if (hasVecTable(conn, "vec_experience") && vecExperience.dimensions !== dimensions) {
    log.info("embedding dimensions changed, rebuilding vec_experience", {
      old: vecExperience.dimensions,
      new: dimensions,
    })
    conn.exec("DROP TABLE IF EXISTS vec_experience")
    vecExperience.ready = false
    vecExperience.dimensions = undefined
  }

  try {
    conn.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_experience USING vec0(
        experience_id TEXT PRIMARY KEY,
        scope_id TEXT partition key,
        reward_status TEXT,
        intent_embedding float[${dimensions}] distance_metric=cosine,
        script_embedding float[${dimensions}] distance_metric=cosine
      )
    `)
    refreshVecTableState(conn, vecExperience, dimensions)
    if (vecExperience.ready) {
      vecExperience.failAt = undefined
      log.info("vec_experience table ready", { dimensions })
    }
  } catch (e) {
    refreshVecTableState(conn, vecExperience, dimensions)
    log.warn("vec_experience creation failed", { error: e })
  }
}

function ensureMemoryVecTable(dimensions: number) {
  const conn = open()
  refreshVecTableState(conn, vecMemory, dimensions)
  if (vecMemory.ready && vecMemory.dimensions === dimensions) return

  if (hasVecTable(conn, "vec_memory") && vecMemory.dimensions !== dimensions) {
    log.info("embedding dimensions changed, rebuilding vec_memory", { old: vecMemory.dimensions, new: dimensions })
    conn.exec("DROP TABLE IF EXISTS vec_memory")
    vecMemory.ready = false
    vecMemory.dimensions = undefined
  }

  try {
    conn.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(
        memory_id TEXT PRIMARY KEY,
        category TEXT,
        embedding float[${dimensions}] distance_metric=cosine
      )
    `)
    refreshVecTableState(conn, vecMemory, dimensions)
    if (vecMemory.ready) {
      vecMemory.failAt = undefined
      log.info("vec_memory table ready", { dimensions })
    }
  } catch (e) {
    refreshVecTableState(conn, vecMemory, dimensions)
    log.warn("vec_memory creation failed", { error: e })
  }
}

function ensureVecTables(dimensions: number) {
  ensureExperienceVecTable(dimensions)
  ensureMemoryVecTable(dimensions)
  if (
    vecExperience.ready &&
    vecExperience.dimensions === dimensions &&
    vecMemory.ready &&
    vecMemory.dimensions === dimensions
  ) {
    embeddingDimensions = dimensions
    const conn = open()
    conn.prepare("UPDATE schema_version SET embedding_dimensions = ?1").run(dimensions)
  }
}

function safeVecExperienceOp<T>(fn: () => T, fallback: T): T {
  return safeVecOp(vecExperience, fn, fallback)
}

function safeVecMemoryOp<T>(fn: () => T, fallback: T): T {
  return safeVecOp(vecMemory, fn, fallback)
}

function toFloat32(vector: number[]): Float32Array {
  return new Float32Array(vector)
}

export function closeDB() {
  if (db) {
    db.close()
    db = undefined
  }
  embeddingDimensions = undefined
  vecExperience.ready = false
  vecMemory.ready = false
  vecExperience.failAt = undefined
  vecMemory.failAt = undefined
  vecExperience.dimensions = undefined
  vecMemory.dimensions = undefined
  vecExperience.expectedDimensions = undefined
  vecMemory.expectedDimensions = undefined
  log.info("closed")
}

export namespace LibraryDB {
  export function dbPath(): string {
    return Global.Path.libraryDB
  }

  export function connection(): Database {
    return open()
  }

  export function isMemoryVecReady(): boolean {
    return vecMemory.ready
  }

  export interface VecTableHealth {
    tableName: string
    exists: boolean
    ready: boolean
    dimensions: number | null
    expectedDimensions: number | null
    rowCount: number | null
  }

  export interface VecHealth {
    schemaDimensions: number | null
    experience: VecTableHealth
    memory: VecTableHealth
  }

  function tableHealth(conn: Database, state: VecTableState): VecTableHealth {
    refreshVecTableState(conn, state, state.expectedDimensions ?? embeddingDimensions)
    return {
      tableName: state.tableName,
      exists: hasVecTable(conn, state.tableName),
      ready: state.ready,
      dimensions: state.dimensions ?? null,
      expectedDimensions: state.expectedDimensions ?? null,
      rowCount: vecTableRowCount(conn, state.tableName),
    }
  }

  export function vecHealth(): VecHealth {
    const conn = open()
    return {
      schemaDimensions: embeddingDimensions ?? null,
      experience: tableHealth(conn, vecExperience),
      memory: tableHealth(conn, vecMemory),
    }
  }

  // ---------------------------------------------------------------------------
  // Experience (passive evolution)
  // ---------------------------------------------------------------------------

  export namespace Experience {
    export interface Rewards {
      outcome?: number
      intent?: number
      execution?: number
      orchestration?: number
      expression?: number
      confidence?: number
      reason?: string
    }

    export type ListFilter = "all" | "scope" | "session"
    export type ListSort = "newest" | "oldest" | "reward" | "qvalue" | "visits"

    export interface RewardWeights {
      outcome: number
      intent: number
      execution: number
      orchestration: number
      expression: number
    }

    export interface PageInput {
      filter: ListFilter
      scopeID?: string
      sessionID?: string
      sort: ListSort
      limit: number
      offset: number
      rewardWeights: RewardWeights
    }

    export interface PageResult {
      items: Row[]
      total: number
      limit: number
      offset: number
      hasMore: boolean
    }

    export const REWARD_DIMS = ["outcome", "intent", "execution", "orchestration", "expression"] as const

    export interface Row {
      id: string
      session_id: string
      scope_id: string
      intent: string
      intent_embedding_model: string | null
      script_embedding_model: string | null
      source_provider_id: string | null
      source_model_id: string | null
      reward: number | null
      rewards: string
      q_values: string
      q_visits: number
      q_updated_at: number | null
      q_history: string
      retrieved_experience_ids: string
      created_at: number
      updated_at: number
      reward_status: string
      turns_remaining: number | null
    }

    export interface ContentRow {
      id: string
      session_id: string
      scope_id: string
      script: string | null
      raw: string | null
      metadata: string
      created_at: number
      updated_at: number
    }

    export interface ContentInput {
      script?: string
      raw?: string
    }

    export function getContent(id: string): ContentRow | null {
      const conn = open()
      return conn.prepare("SELECT * FROM experience_content WHERE id = ?1").get(id) as ContentRow | null
    }

    function buildPageWhere(input: PageInput) {
      const conditions: string[] = []
      const params: SQLQueryBindings[] = []

      if (input.filter === "scope" && input.scopeID) {
        conditions.push("scope_id = ?")
        params.push(input.scopeID)
      }

      if (input.filter === "session" && input.sessionID) {
        conditions.push("session_id = ?")
        params.push(input.sessionID)
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
      return { where, params }
    }

    function buildPageOrder(sort: ListSort, rewardWeights: RewardWeights) {
      const qValueExpr = `(
        COALESCE(CAST(json_extract(q_values, '$.outcome') AS REAL), 0) * ${rewardWeights.outcome} +
        COALESCE(CAST(json_extract(q_values, '$.intent') AS REAL), 0) * ${rewardWeights.intent} +
        COALESCE(CAST(json_extract(q_values, '$.execution') AS REAL), 0) * ${rewardWeights.execution} +
        COALESCE(CAST(json_extract(q_values, '$.orchestration') AS REAL), 0) * ${rewardWeights.orchestration} +
        COALESCE(CAST(json_extract(q_values, '$.expression') AS REAL), 0) * ${rewardWeights.expression}
      )`

      switch (sort) {
        case "oldest":
          return "ORDER BY created_at ASC, id ASC"
        case "reward":
          return "ORDER BY reward IS NULL ASC, reward DESC, created_at DESC, id DESC"
        case "qvalue":
          return `ORDER BY ${qValueExpr} DESC, created_at DESC, id DESC`
        case "visits":
          return "ORDER BY q_visits DESC, created_at DESC, id DESC"
        case "newest":
        default:
          return "ORDER BY created_at DESC, id DESC"
      }
    }

    export function list(scopeID: string): Row[] {
      const conn = open()
      return conn.prepare("SELECT * FROM experience WHERE scope_id = ?1 ORDER BY created_at DESC").all(scopeID) as Row[]
    }

    export function page(input: PageInput): PageResult {
      const conn = open()
      const { where, params } = buildPageWhere(input)
      const order = buildPageOrder(input.sort, input.rewardWeights)
      const countQuery = `SELECT COUNT(*) as cnt FROM experience ${where}`
      const itemsQuery = `SELECT * FROM experience ${where} ${order} LIMIT ? OFFSET ?`
      const total = (conn.prepare(countQuery).get(...params) as { cnt: number }).cnt
      const items = conn.prepare(itemsQuery).all(...params, input.limit, input.offset) as Row[]

      return {
        items,
        total,
        limit: input.limit,
        offset: input.offset,
        hasMore: input.offset + items.length < total,
      }
    }

    export function remove(id: string) {
      const conn = open()
      conn.prepare("DELETE FROM experience WHERE id = ?1").run(id)
      conn.prepare("DELETE FROM experience_content WHERE id = ?1").run(id)
      safeVecExperienceOp(() => conn.prepare("DELETE FROM vec_experience WHERE experience_id = ?1").run(id), undefined)
      log.info("experience.remove", { id })
    }

    export function get(id: string): Row | null {
      const conn = open()
      return conn.prepare("SELECT * FROM experience WHERE id = ?1").get(id) as Row | null
    }

    export function getMany(ids: string[]): Row[] {
      if (ids.length === 0) return []
      const conn = open()
      const placeholders = ids.map(() => "?").join(",")
      return conn.prepare(`SELECT * FROM experience WHERE id IN (${placeholders})`).all(...ids) as Row[]
    }

    export function listAll(): Row[] {
      const conn = open()
      return conn.prepare("SELECT * FROM experience ORDER BY created_at DESC").all() as Row[]
    }

    export function count(): number {
      const conn = open()
      const row = conn.prepare("SELECT COUNT(*) as cnt FROM experience").get() as { cnt: number }
      return row.cnt
    }

    export function removeAll(): number {
      const conn = open()
      const r1 = conn.prepare("DELETE FROM experience").run()
      conn.prepare("DELETE FROM experience_content").run()
      safeVecExperienceOp(() => conn.prepare("DELETE FROM vec_experience").run(), undefined)
      log.info("experience.removeAll", { deleted: r1.changes })
      return r1.changes
    }

    export function removeByScope(scopeID: string): number {
      const conn = open()
      const r1 = conn.prepare("DELETE FROM experience WHERE scope_id = ?1").run(scopeID)
      conn.prepare("DELETE FROM experience_content WHERE scope_id = ?1").run(scopeID)
      safeVecExperienceOp(() => {
        conn.prepare("DELETE FROM vec_experience WHERE scope_id = ?1").run(scopeID)
      }, undefined)
      log.info("experience.removeByScope", { scopeID, deleted: r1.changes })
      return r1.changes
    }

    export function renameScope(fromScopeID: string, toScopeID: string): number {
      const conn = open()
      const r1 = conn.prepare("UPDATE experience SET scope_id = ?1 WHERE scope_id = ?2").run(toScopeID, fromScopeID)
      const r2 = conn
        .prepare("UPDATE experience_content SET scope_id = ?1 WHERE scope_id = ?2")
        .run(toScopeID, fromScopeID)
      safeVecExperienceOp(() => {
        conn.prepare("UPDATE vec_experience SET scope_id = ?1 WHERE scope_id = ?2").run(toScopeID, fromScopeID)
      }, undefined)
      const changed = r1.changes + r2.changes
      log.info("experience.renameScope", { fromScopeID, toScopeID, changed })
      return changed
    }

    export interface DuplicateInfo {
      id: string
      intentSimilarity: number
      scriptSimilarity?: number
      rewardStatus: string
      compositeQ: number
    }

    export function findSimilar(
      scopeID: string,
      intentVector: number[],
      intentThreshold: number,
      scriptVector?: number[],
      scriptThreshold?: number,
      rewardWeights?: Record<string, number>,
    ): DuplicateInfo | null {
      const conn = open()
      const row = safeVecExperienceOp(
        () =>
          conn
            .prepare(
              `SELECT experience_id, distance
               FROM vec_experience
               WHERE intent_embedding MATCH ?1 AND k = 1 AND scope_id = ?2`,
            )
            .get(toFloat32(intentVector), scopeID) as { experience_id: string; distance: number } | null,
        null,
      )

      if (!row) return null
      const intentSimilarity = 1 - row.distance
      if (intentSimilarity < intentThreshold) return null

      if (!scriptVector || !scriptThreshold) {
        const existing = get(row.experience_id)
        return existing
          ? {
              id: row.experience_id,
              intentSimilarity,
              rewardStatus: existing.reward_status,
              compositeQ: compositeQ(existing, rewardWeights),
            }
          : null
      }

      const scriptResults = safeVecExperienceOp(
        () =>
          conn
            .prepare(
              `SELECT experience_id, distance
               FROM vec_experience
               WHERE script_embedding MATCH ?1 AND k = 50 AND scope_id = ?2`,
            )
            .all(toFloat32(scriptVector), scopeID) as { experience_id: string; distance: number }[],
        [] as { experience_id: string; distance: number }[],
      )

      const scriptMatch = scriptResults.find((r) => r.experience_id === row.experience_id)
      if (!scriptMatch) return null

      const scriptSimilarity = 1 - scriptMatch.distance
      if (scriptSimilarity < scriptThreshold) return null

      const existing = get(row.experience_id)
      return existing
        ? {
            id: row.experience_id,
            intentSimilarity,
            scriptSimilarity,
            rewardStatus: existing.reward_status,
            compositeQ: compositeQ(existing, rewardWeights),
          }
        : null
    }

    function compositeQ(row: Row, weights?: Record<string, number>): number {
      const qv: Record<string, number> = JSON.parse(row.q_values)
      const w = weights ?? { outcome: 0.35, intent: 0.25, execution: 0.2, orchestration: 0.1, expression: 0.1 }
      return (
        (qv.outcome ?? 0) * (w.outcome ?? 0.35) +
        (qv.intent ?? 0) * (w.intent ?? 0.25) +
        (qv.execution ?? 0) * (w.execution ?? 0.2) +
        (qv.orchestration ?? 0) * (w.orchestration ?? 0.1) +
        (qv.expression ?? 0) * (w.expression ?? 0.1)
      )
    }

    export interface KNNResult {
      id: string
      distance: number
    }

    export function searchByIntent(scopeID: string, queryVector: number[], topK: number): KNNResult[] {
      const conn = open()
      return safeVecExperienceOp(
        () =>
          conn
            .prepare(
              `SELECT experience_id AS id, distance
               FROM vec_experience
               WHERE intent_embedding MATCH ?1 AND k = ?2 AND scope_id = ?3 AND reward_status = 'evaluated'`,
            )
            .all(toFloat32(queryVector), topK, scopeID) as KNNResult[],
        [] as KNNResult[],
      )
    }

    export function searchByIntentAll(queryVector: number[], topK: number): KNNResult[] {
      const conn = open()
      return safeVecExperienceOp(
        () =>
          conn
            .prepare(
              `SELECT experience_id AS id, distance
               FROM vec_experience
               WHERE intent_embedding MATCH ?1 AND k = ?2 AND reward_status = 'evaluated'`,
            )
            .all(toFloat32(queryVector), topK) as KNNResult[],
        [] as KNNResult[],
      )
    }

    export interface ApplyRewardInput {
      rewards: Rewards
      rewardWeights: Record<string, number>
      alpha: number
      qHistorySize?: number
    }

    export function applyReward(
      id: string,
      input: ApplyRewardInput,
    ): { compositeReward: number; rewards: Rewards } | null {
      const conn = open()
      const row = conn.prepare("SELECT * FROM experience WHERE id = ?1").get(id) as Row | null
      if (!row) return null

      const rewards = input.rewards
      const w = input.rewardWeights
      const compositeReward = Math.max(
        -1,
        Math.min(
          1,
          (rewards.outcome ?? 0) * (w.outcome ?? 0.35) +
            (rewards.intent ?? 0) * (w.intent ?? 0.25) +
            (rewards.execution ?? 0) * (w.execution ?? 0.2) +
            (rewards.orchestration ?? 0) * (w.orchestration ?? 0.1) +
            (rewards.expression ?? 0) * (w.expression ?? 0.1),
        ),
      )

      conn
        .prepare(
          "UPDATE experience SET reward = ?1, rewards = ?2, reward_status = 'evaluated', turns_remaining = 0, updated_at = ?3 WHERE id = ?4",
        )
        .run(compositeReward, JSON.stringify(rewards), Date.now(), id)

      safeVecExperienceOp(
        () => conn.prepare("UPDATE vec_experience SET reward_status = 'evaluated' WHERE experience_id = ?1").run(id),
        undefined,
      )

      const retrievedIDs: string[] = JSON.parse(row.retrieved_experience_ids)
      const confidence = rewards.confidence ?? 1
      const effectiveAlpha = input.alpha * confidence
      for (const rid of retrievedIDs) {
        updateQValues(rid, effectiveAlpha, rewards, input.qHistorySize)
      }

      log.info("experience.applyReward", { id, compositeReward, rewards })
      return { compositeReward, rewards }
    }

    const DEFAULT_Q_HISTORY_SIZE = 50

    export function updateQValues(id: string, alpha: number, rewardVector: Rewards, qHistorySize?: number): Row | null {
      const conn = open()
      const row = conn.prepare("SELECT * FROM experience WHERE id = ?1").get(id) as Row | null
      if (!row) return null

      const oldQ: Record<string, number> = JSON.parse(row.q_values)
      const newQ: Record<string, number> = { ...oldQ }
      for (const dim of REWARD_DIMS) {
        const reward = rewardVector[dim]
        if (reward === undefined) continue
        const oldVal = oldQ[dim] ?? 0
        newQ[dim] = (1 - alpha) * oldVal + alpha * reward
      }

      const maxSize = qHistorySize ?? DEFAULT_Q_HISTORY_SIZE
      const history: Record<string, number>[] = JSON.parse(row.q_history)
      history.push(oldQ)
      if (history.length > maxSize) {
        history.splice(0, history.length - maxSize)
      }

      const now = Date.now()
      conn
        .prepare(
          `UPDATE experience
         SET q_values = ?1, q_visits = q_visits + 1, q_updated_at = ?2, q_history = ?3, updated_at = ?4
         WHERE id = ?5`,
        )
        .run(JSON.stringify(newQ), now, JSON.stringify(history), now, id)

      log.info("experience.updateQValues", { id, oldQ, newQ, visits: row.q_visits + 1 })

      return conn.prepare("SELECT * FROM experience WHERE id = ?1").get(id) as Row
    }

    export function listPendingRewards(sessionID: string): Row[] {
      const conn = open()
      return conn
        .prepare("SELECT * FROM experience WHERE session_id = ?1 AND reward_status = 'pending' ORDER BY created_at ASC")
        .all(sessionID) as Row[]
    }

    export function listFailed(sessionID: string): Row[] {
      const conn = open()
      return conn
        .prepare(
          "SELECT * FROM experience WHERE session_id = ?1 AND reward_status = 'encoding_failed' ORDER BY created_at ASC",
        )
        .all(sessionID) as Row[]
    }

    /**
     * Targeted intent update for re-encode. Only touches intent + embedding columns;
     * preserves reward_status, q_values, and all other fields.
     */
    export function updateIntent(id: string, intent: string, embedding: Embedding.Info) {
      const conn = open()
      const now = Date.now()
      const dimensions = embedding.vector.length
      conn
        .prepare(`UPDATE experience SET intent = ?1, intent_embedding_model = ?2, updated_at = ?3 WHERE id = ?4`)
        .run(intent, embedding.model, now, id)
      ensureVecTables(dimensions)
      safeVecExperienceOp(() => {
        conn
          .prepare(`UPDATE vec_experience SET intent_embedding = ?1 WHERE experience_id = ?2`)
          .run(toFloat32(embedding.vector), id)
      }, undefined)
      log.info("experience.updateIntent", { id })
    }

    /**
     * Targeted script update for re-encode. Updates experience_content.script,
     * ve_experience.script_embedding, and experience.script_embedding_model.
     */
    export function updateScript(id: string, script: string, embedding: Embedding.Info, raw: string) {
      const conn = open()
      const now = Date.now()
      const dimensions = embedding.vector.length
      conn
        .prepare(`UPDATE experience SET script_embedding_model = ?1, updated_at = ?2 WHERE id = ?3`)
        .run(embedding.model, now, id)
      conn
        .prepare(`UPDATE experience_content SET script = ?1, raw = ?2, updated_at = ?3 WHERE id = ?4`)
        .run(script, raw, now, id)
      ensureVecTables(dimensions)
      safeVecExperienceOp(() => {
        conn
          .prepare(`UPDATE vec_experience SET script_embedding = ?1 WHERE experience_id = ?2`)
          .run(toFloat32(embedding.vector), id)
      }, undefined)
      log.info("experience.updateScript", { id })
    }
    export function updateTurnsRemaining(id: string, turnsRemaining: number) {
      const conn = open()
      conn
        .prepare("UPDATE experience SET turns_remaining = ?1, updated_at = ?2 WHERE id = ?3")
        .run(turnsRemaining, Date.now(), id)
    }

    export function insertFailed(input: {
      id: string
      sessionID: string
      scopeID: string
      createdAt: number
      sourceProviderID?: string
      sourceModelID?: string
    }) {
      const conn = open()
      const now = Date.now()
      conn
        .prepare(
          `INSERT INTO experience (id, session_id, scope_id, intent, intent_embedding_model,
           script_embedding_model, source_provider_id, source_model_id, reward, rewards, q_values, q_visits,
           q_updated_at, q_history, retrieved_experience_ids, reward_status, created_at, updated_at)
         VALUES (?1, ?2, ?3, '', NULL, NULL, ?4, ?5, NULL, '{}', '{}', 0, NULL, '[]', '[]', 'encoding_failed', ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
           source_provider_id = excluded.source_provider_id,
           source_model_id = excluded.source_model_id,
           reward_status = 'encoding_failed',
           updated_at = excluded.updated_at`,
        )
        .run(
          input.id,
          input.sessionID,
          input.scopeID,
          input.sourceProviderID ?? null,
          input.sourceModelID ?? null,
          input.createdAt,
          now,
        )
      log.info("experience.insertFailed", { id: input.id })
    }

    export function insert(input: {
      id: string
      sessionID: string
      scopeID: string
      intent: string
      sourceProviderID?: string
      sourceModelID?: string
      intentEmbedding: Embedding.Info
      scriptEmbedding: Embedding.Info | undefined
      content: ContentInput
      metadata: object
      retrievedExperienceIDs: string[]
      createdAt: number
      qInit?: number
    }) {
      const conn = open()
      const now = Date.now()
      const dimensions = input.intentEmbedding.vector.length
      const qInit = input.qInit ?? 0
      const qValues = JSON.stringify(Object.fromEntries(REWARD_DIMS.map((d) => [d, qInit])))

      conn
        .prepare(
          `INSERT INTO experience (id, session_id, scope_id, intent, intent_embedding_model,
           script_embedding_model, source_provider_id, source_model_id, reward, rewards, q_values, q_visits,
           q_updated_at, q_history, retrieved_experience_ids, reward_status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, '{}', ?9, 0, NULL, '[]', ?10, 'pending', ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
           intent = excluded.intent,
           intent_embedding_model = excluded.intent_embedding_model,
           script_embedding_model = excluded.script_embedding_model,
           source_provider_id = excluded.source_provider_id,
           source_model_id = excluded.source_model_id,
           retrieved_experience_ids = excluded.retrieved_experience_ids,
           q_values = excluded.q_values,
           reward_status = 'pending',
           updated_at = excluded.updated_at`,
        )
        .run(
          input.id,
          input.sessionID,
          input.scopeID,
          input.intent,
          input.intentEmbedding.model,
          input.scriptEmbedding?.model ?? null,
          input.sourceProviderID ?? null,
          input.sourceModelID ?? null,
          qValues,
          JSON.stringify(input.retrievedExperienceIDs),
          input.createdAt,
          now,
        )

      ensureVecTables(dimensions)
      safeVecExperienceOp(() => {
        conn.prepare("DELETE FROM vec_experience WHERE experience_id = ?1").run(input.id)
        conn
          .prepare(
            `INSERT INTO vec_experience (experience_id, scope_id, reward_status, intent_embedding, script_embedding)
           VALUES (?1, ?2, 'pending', ?3, ?4)`,
          )
          .run(
            input.id,
            input.scopeID,
            toFloat32(input.intentEmbedding.vector),
            input.scriptEmbedding ? toFloat32(input.scriptEmbedding.vector) : new Float32Array(dimensions),
          )
      }, undefined)

      conn
        .prepare(
          `INSERT INTO experience_content (id, session_id, scope_id, script, raw, metadata, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           script = excluded.script, raw = excluded.raw, metadata = excluded.metadata, updated_at = excluded.updated_at`,
        )
        .run(
          input.id,
          input.sessionID,
          input.scopeID,
          input.content.script ?? null,
          input.content.raw ?? null,
          JSON.stringify(input.metadata),
          input.createdAt,
          now,
        )

      log.info("experience.insert", { id: input.id })
    }

    export function supersede(
      existingID: string,
      input: {
        sessionID: string
        scopeID: string
        intent: string
        sourceProviderID?: string
        sourceModelID?: string
        intentEmbedding: Embedding.Info
        scriptEmbedding: Embedding.Info | undefined
        content: ContentInput
        metadata: object
        retrievedExperienceIDs: string[]
      },
    ): boolean {
      const conn = open()
      const existing = get(existingID)
      if (!existing) return false

      const now = Date.now()
      const dimensions = input.intentEmbedding.vector.length

      conn
        .prepare(
          `UPDATE experience SET
           intent = ?1, session_id = ?2, scope_id = ?3,
           intent_embedding_model = ?4, script_embedding_model = ?5,
           source_provider_id = ?6, source_model_id = ?7,
           retrieved_experience_ids = ?8,
           reward_status = 'pending', turns_remaining = NULL,
           updated_at = ?9
           WHERE id = ?10`,
        )
        .run(
          input.intent,
          input.sessionID,
          input.scopeID,
          input.intentEmbedding.model,
          input.scriptEmbedding?.model ?? null,
          input.sourceProviderID ?? null,
          input.sourceModelID ?? null,
          JSON.stringify(input.retrievedExperienceIDs),
          now,
          existingID,
        )

      ensureVecTables(dimensions)
      safeVecExperienceOp(() => {
        conn.prepare("DELETE FROM vec_experience WHERE experience_id = ?1").run(existingID)
        conn
          .prepare(
            `INSERT INTO vec_experience (experience_id, scope_id, reward_status, intent_embedding, script_embedding)
           VALUES (?1, ?2, 'pending', ?3, ?4)`,
          )
          .run(
            existingID,
            input.scopeID,
            toFloat32(input.intentEmbedding.vector),
            input.scriptEmbedding ? toFloat32(input.scriptEmbedding.vector) : new Float32Array(dimensions),
          )
      }, undefined)

      conn
        .prepare(
          `INSERT INTO experience_content (id, session_id, scope_id, script, raw, metadata, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           script = excluded.script, raw = excluded.raw, metadata = excluded.metadata, updated_at = excluded.updated_at`,
        )
        .run(
          existingID,
          input.sessionID,
          input.scopeID,
          input.content.script ?? null,
          input.content.raw ?? null,
          JSON.stringify(input.metadata),
          existing.created_at,
          now,
        )

      log.info("experience.supersede", { id: existingID })
      return true
    }
  }

  // ---------------------------------------------------------------------------
  // Memory (active evolution — long-term notes)
  // ---------------------------------------------------------------------------

  export namespace Memory {
    export type Category = MemoryCategory
    export type RecallMode = MemoryRecallMode

    export const CATEGORIES: Category[] = [...MEMORY_CATEGORIES]
    export const RECALL_MODES: RecallMode[] = [...MEMORY_RECALL_MODES]
    export const IDENTITY_CATEGORIES: Category[] = ["user", "self", "relationship", "interaction"]
    export const KNOWLEDGE_CATEGORIES: Category[] = [
      "workflow",
      "coding",
      "writing",
      "asset",
      "insight",
      "knowledge",
      "personal",
      "general",
    ]

    export interface Row {
      id: string
      title: string
      content: string
      category: Category
      recall_mode: RecallMode
      embedding_model: string | null
      created_at: number
      updated_at: number
    }

    export interface ListInput {
      categories?: Category[]
      recallModes?: RecallMode[]
    }

    export function insert(
      input: { id: string; title: string; content: string; category: Category; recallMode: RecallMode },
      embedding: Embedding.Info,
    ): Row {
      const conn = open()
      const now = Date.now()
      conn
        .prepare(
          `INSERT INTO memory (id, title, content, category, recall_mode, embedding_model, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .run(input.id, input.title, input.content, input.category, input.recallMode, embedding.model, now, now)

      ensureVecTables(embedding.vector.length)
      safeVecMemoryOp(
        () =>
          conn
            .prepare("INSERT INTO vec_memory (memory_id, category, embedding) VALUES (?1, ?2, ?3)")
            .run(input.id, input.category, toFloat32(embedding.vector)),
        undefined,
      )

      log.info("memory.insert", {
        id: input.id,
        title: input.title,
        category: input.category,
        recallMode: input.recallMode,
      })
      return {
        id: input.id,
        title: input.title,
        content: input.content,
        category: input.category,
        recall_mode: input.recallMode,
        embedding_model: embedding.model,
        created_at: now,
        updated_at: now,
      }
    }

    export function update(
      input: { id: string; title: string; content: string; category: Category; recallMode: RecallMode },
      embedding: Embedding.Info,
    ): Row | null {
      const conn = open()
      const now = Date.now()
      const result = conn
        .prepare(
          `UPDATE memory SET title = ?1, content = ?2, category = ?3, recall_mode = ?4, embedding_model = ?5, updated_at = ?6
         WHERE id = ?7`,
        )
        .run(input.title, input.content, input.category, input.recallMode, embedding.model, now, input.id)
      if (result.changes === 0) return null

      ensureVecTables(embedding.vector.length)
      safeVecMemoryOp(() => {
        conn.prepare("DELETE FROM vec_memory WHERE memory_id = ?1").run(input.id)
        conn
          .prepare("INSERT INTO vec_memory (memory_id, category, embedding) VALUES (?1, ?2, ?3)")
          .run(input.id, input.category, toFloat32(embedding.vector))
      }, undefined)

      log.info("memory.update", {
        id: input.id,
        title: input.title,
        category: input.category,
        recallMode: input.recallMode,
      })
      return conn.prepare("SELECT * FROM memory WHERE id = ?1").get(input.id) as Row
    }

    export function get(id: string): Row | null {
      const conn = open()
      return conn.prepare("SELECT * FROM memory WHERE id = ?1").get(id) as Row | null
    }

    export function getMany(ids: string[]): Row[] {
      if (ids.length === 0) return []
      const conn = open()
      const placeholders = ids.map(() => "?").join(",")
      return conn
        .prepare(`SELECT * FROM memory WHERE id IN (${placeholders}) ORDER BY created_at DESC`)
        .all(...ids) as Row[]
    }

    function buildListWhere(input: ListInput) {
      const conditions: string[] = []
      const params: SQLQueryBindings[] = []

      if (input.categories && input.categories.length > 0) {
        conditions.push(`category IN (${input.categories.map(() => "?").join(",")})`)
        params.push(...input.categories)
      }

      if (input.recallModes && input.recallModes.length > 0) {
        conditions.push(`recall_mode IN (${input.recallModes.map(() => "?").join(",")})`)
        params.push(...input.recallModes)
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
      return { where, params }
    }

    export function listAll(): Row[] {
      return list({})
    }

    export function list(input: ListInput): Row[] {
      const conn = open()
      const { where, params } = buildListWhere(input)
      return conn.prepare(`SELECT * FROM memory ${where} ORDER BY category, created_at ASC`).all(...params) as Row[]
    }

    export function listByCategories(categories: Category[]): Row[] {
      return list({ categories })
    }

    export interface KNNResult {
      id: string
      distance: number
    }

    export function searchByVector(queryVector: number[], topK: number, category?: Category): KNNResult[] {
      const conn = open()
      if (category) {
        return safeVecMemoryOp(
          () =>
            conn
              .prepare(
                `SELECT memory_id AS id, distance
                 FROM vec_memory
                 WHERE embedding MATCH ?1 AND k = ?2 AND category = ?3`,
              )
              .all(toFloat32(queryVector), topK, category) as KNNResult[],
          [] as KNNResult[],
        )
      }
      return safeVecMemoryOp(
        () =>
          conn
            .prepare(
              `SELECT memory_id AS id, distance
               FROM vec_memory
               WHERE embedding MATCH ?1 AND k = ?2`,
            )
            .all(toFloat32(queryVector), topK) as KNNResult[],
        [] as KNNResult[],
      )
    }

    export function remove(id: string) {
      const conn = open()
      conn.prepare("DELETE FROM memory WHERE id = ?1").run(id)
      safeVecMemoryOp(() => conn.prepare("DELETE FROM vec_memory WHERE memory_id = ?1").run(id), undefined)
      log.info("memory.remove", { id })
    }

    export function removeAll(): number {
      const conn = open()
      const result = conn.prepare("DELETE FROM memory").run()
      safeVecMemoryOp(() => conn.prepare("DELETE FROM vec_memory").run(), undefined)
      log.info("memory.removeAll", { deleted: result.changes })
      return result.changes
    }

    export function count(): number {
      const conn = open()
      const row = conn.prepare("SELECT COUNT(*) as cnt FROM memory").get() as { cnt: number }
      return row.cnt
    }
  }
}
