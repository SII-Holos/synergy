import { Database } from "bun:sqlite"
import fsSync from "fs"
import { ObservabilityConfig } from "@/observability/config"
import { ObservabilitySchema } from "./schema"
import { ObservabilitySqliteMaintenance } from "./sqlite-maintenance"
import { ObservabilityDbSchema } from "./db-schema"
import { ObservabilityPaths } from "./paths"
import { ObservabilityDbWrites } from "./db-writes"
import { ObservabilityTelemetryClient } from "./telemetry-client"
import { TelemetryProtocol } from "./telemetry-protocol"

export namespace ObservabilityStore {
  export const schemaVersion = ObservabilityDbSchema.schemaVersion
  const MAX_PENDING = 10_000
  const FLUSH_MS = 1000
  let db: Database | undefined
  let readonlyDb: Database | undefined
  let clientActive = false
  let checkpointTimer: ReturnType<typeof setInterval> | undefined
  let compactTimer: ReturnType<typeof setInterval> | undefined
  let retentionTimer: ReturnType<typeof setInterval> | undefined
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let retentionQueued = false
  let droppedJobs = 0
  let lastOpenError: string | undefined
  let openFailed = false
  let capExceededBytes = 0
  let maintenanceDeferred = false
  let checkpointIntervalMs: number | undefined
  let retentionIntervalMs: number | undefined
  const pending: Array<() => void> = []
  const beforeFlushHooks = new Set<() => void>()
  let dataVersionCounter = 0

  // Monotonic write counter so read-side caches (e.g. the dashboard summary)
  // can invalidate when new telemetry lands instead of serving stale rows.
  export function dataVersion() {
    return dataVersionCounter
  }

  function inlineMode() {
    return process.env.SYNERGY_OBSERVABILITY_INLINE === "1"
  }

  // Set once migrations complete. Before that, runtime reconfiguration must
  // not start the telemetry worker: the migration window still needs the
  // inline write connection, and a second write connection would race it.
  let runtimeReady = false

  export function markRuntimeReady() {
    runtimeReady = true
  }

  // In worker mode the migration window is the only time the Control Plane
  // writes directly; release that connection before the worker takes over.
  export function releaseMigrationConnection() {
    if (!inlineMode() && db) {
      db.close(false)
      db = undefined
    }
  }

  function workerConfigFrom(config: ReturnType<typeof ObservabilityConfig.current>): TelemetryProtocol.WorkerConfig {
    return {
      maxSqliteBytes: config.storage.maxSqliteBytes,
      walCheckpointIntervalMs: config.storage.walCheckpointIntervalMs,
      metricRetentionMs: config.metricRetentionMs,
      traceRetentionMs: config.traceRetentionMs,
      maintenanceBudgetMs: 500,
    }
  }

  // Worker-mode enqueue must honor the same enabled guard as the inline
  // enqueue: telemetry produced while observability is disabled is dropped,
  // not buffered for a later re-enable.
  function workerEnqueue(row: TelemetryProtocol.BatchRow) {
    if (!ObservabilityConfig.current().enabled) return
    ObservabilityTelemetryClient.enqueue(row)
  }

  function queryConnection(): Database | undefined {
    if (!inlineMode()) {
      if (!readonlyDb) {
        try {
          const conn = new Database(pathName(), { readonly: true })
          conn.exec("PRAGMA busy_timeout=5000")
          readonlyDb = conn
        } catch {
          return undefined
        }
      }
      return readonlyDb
    }
    return open()
  }

  export function stats() {
    if (!inlineMode()) {
      const client = ObservabilityTelemetryClient.stats()
      const config = ObservabilityConfig.current()
      return {
        pending: client.pending,
        dropped: droppedJobs + client.dropped,
        available: queryConnection() !== undefined,
        lastOpenError,
        capExceededBytes: client.capExceededBytes,
        maintenanceDeferred: client.maintenanceDeferred,
        checkpointIntervalMs: config.storage.walCheckpointIntervalMs,
        retentionIntervalMs: TelemetryProtocol.RETENTION_INTERVAL_MS,
      }
    }
    return {
      pending: pending.length,
      dropped: droppedJobs,
      available: !!db,
      lastOpenError,
      capExceededBytes,
      maintenanceDeferred,
      checkpointIntervalMs,
      retentionIntervalMs,
    }
  }

  export function beforeFlush(hook: () => void) {
    beforeFlushHooks.add(hook)
    return () => beforeFlushHooks.delete(hook)
  }

  export function dir() {
    return ObservabilityPaths.dir()
  }

  export function pathName() {
    return ObservabilityPaths.pathName()
  }

  export function legacyPerformancePath() {
    return ObservabilityPaths.legacyPerformancePath()
  }

  export function open(): Database | undefined {
    if (!inlineMode()) {
      const config = ObservabilityConfig.current()
      if (!config.enabled || !config.storage.sqliteEnabled) return undefined
      if (!runtimeReady) return undefined
      if (!clientActive) {
        ObservabilityTelemetryClient.start({ dbPath: pathName(), config: workerConfigFrom(config) })
        clientActive = true
      }
      return queryConnection()
    }
    if (db) return db
    const config = ObservabilityConfig.current()
    if (!config.enabled || !config.storage.sqliteEnabled) return undefined
    if (openFailed) return undefined
    try {
      db = createConnection()
      lastOpenError = undefined
    } catch (error) {
      openFailed = true
      lastOpenError = error instanceof Error ? error.message : String(error)
      return undefined
    }
    scheduleTimers(config)
    queueRetention()
    return db
  }

  export function reconfigure() {
    const config = ObservabilityConfig.current()
    if (!config.enabled || !config.storage.sqliteEnabled) {
      close()
      return
    }
    if (!inlineMode()) {
      if (!runtimeReady) return
      if (!clientActive) {
        ObservabilityTelemetryClient.start({ dbPath: pathName(), config: workerConfigFrom(config) })
        clientActive = true
      } else {
        ObservabilityTelemetryClient.sendReconfigure(workerConfigFrom(config))
      }
      return
    }
    clearTimers()
    if (!db) {
      openFailed = false
      open()
      return
    }
    scheduleTimers(config)
    enforceMaxSize(db, config.storage.maxSqliteBytes)
  }

  function scheduleTimers(config: ReturnType<typeof ObservabilityConfig.current>) {
    checkpointIntervalMs = config.storage.walCheckpointIntervalMs
    retentionIntervalMs = Math.max(config.metricRetentionMs / 4, 60_000)
    checkpointTimer = setInterval(checkpointSafely, config.storage.walCheckpointIntervalMs)
    checkpointTimer.unref()
    compactTimer = setInterval(maintainSizeSafely, Math.min(config.storage.walCheckpointIntervalMs * 10, 600_000))
    compactTimer.unref()
    retentionTimer = setInterval(() => retain(), retentionIntervalMs)
    retentionTimer.unref()
  }

  export function close() {
    if (!inlineMode()) {
      clearTimers()
      flush()
      readonlyDb?.close(false)
      readonlyDb = undefined
      void ObservabilityTelemetryClient.stop()
      clientActive = false
      return
    }
    // Stop every producer before draining the queue. A timer firing between
    // flush() and close() can otherwise retain a statement and make SQLite's
    // strict close report SQLITE_BUSY during shutdown.
    clearTimers()
    flush()
    if (db) checkpointConnectionSafely(db)
    // All queued writes have been committed above. Non-throwing close uses
    // sqlite3_close_v2 semantics, so outstanding cached statements can finish
    // without turning an otherwise clean server shutdown into an exception.
    db?.close(false)
    db = undefined
    openFailed = false
  }

  function clearTimers() {
    if (checkpointTimer) clearInterval(checkpointTimer)
    if (retentionTimer) clearInterval(retentionTimer)
    if (flushTimer) clearTimeout(flushTimer)
    checkpointTimer = undefined
    if (compactTimer) {
      clearInterval(compactTimer)
      compactTimer = undefined
    }
    retentionTimer = undefined
    flushTimer = undefined
    checkpointIntervalMs = undefined
    retentionIntervalMs = undefined
  }

  export function checkpoint() {
    if (!inlineMode()) {
      ObservabilityTelemetryClient.sendCheckpoint()
      return
    }
    const conn = open()
    if (!conn) return
    checkpointConnection(conn)
  }

  export function insertMetric(metric: ObservabilitySchema.Metric) {
    dataVersionCounter++
    if (!inlineMode()) {
      workerEnqueue({ kind: "metric", row: metric })
      return
    }
    enqueue(() => {
      const conn = open()
      if (conn) ObservabilityDbWrites.insertMetric(conn, metric)
    })
  }

  export function insertSpan(span: ObservabilitySchema.Span) {
    dataVersionCounter++
    if (!inlineMode()) {
      workerEnqueue({ kind: "span", row: span })
      return
    }
    enqueue(() => {
      const conn = open()
      if (conn) ObservabilityDbWrites.upsertSpan(conn, span)
    })
  }

  export function updateSpan(span: ObservabilitySchema.Span) {
    insertSpan(span)
  }

  export function insertEvent(event: ObservabilitySchema.Event) {
    dataVersionCounter++
    if (!inlineMode()) {
      workerEnqueue({ kind: "event", row: event })
      return
    }
    enqueue(() => {
      const conn = open()
      if (conn) ObservabilityDbWrites.insertEvent(conn, event)
    })
  }

  export function insertResource(sample: ObservabilitySchema.ResourceSample) {
    dataVersionCounter++
    if (!inlineMode()) {
      workerEnqueue({ kind: "resource", row: sample })
      return
    }
    enqueue(() => {
      const conn = open()
      if (conn) ObservabilityDbWrites.insertResource(conn, sample)
    })
  }

  export function insertIssue(issue: ObservabilitySchema.Issue) {
    dataVersionCounter++
    if (!inlineMode()) {
      workerEnqueue({ kind: "issue", row: issue })
      return
    }
    enqueue(() => {
      const conn = open()
      if (conn) ObservabilityDbWrites.insertIssue(conn, issue)
    })
  }

  export function insertBrowserBatch(input: {
    batchId: string
    receivedTime: number
    sentAt: number
    accepted: number
    rejected: number
    page: Record<string, unknown>
  }) {
    dataVersionCounter++
    if (!inlineMode()) {
      workerEnqueue({ kind: "browser-batch", row: input })
      return
    }
    enqueue(() => {
      const conn = open()
      if (conn) ObservabilityDbWrites.insertBrowserBatch(conn, input)
    })
  }

  export function queryEvents(input: ObservabilitySchema.Query = {}) {
    flush()
    const conn = queryConnection()
    if (!conn) return [] as StoredEvent[]
    const filters: string[] = []
    const params: Array<string | number> = []
    if (input.since !== undefined) {
      filters.push("time >= ?")
      params.push(input.since)
    }
    if (input.until !== undefined) {
      filters.push("time < ?")
      params.push(input.until)
    }
    if (input.traceId) {
      filters.push("trace_id = ?")
      params.push(input.traceId)
    }
    if (input.correlationId) {
      filters.push("correlation_id = ?")
      params.push(input.correlationId)
    }
    if (input.sessionID) {
      filters.push("session_id = ?")
      params.push(input.sessionID)
    }
    if (input.callID) {
      filters.push("call_id = ?")
      params.push(input.callID)
    }
    if (input.level) {
      filters.push("level = ?")
      params.push(input.level)
    }
    if (input.type) {
      filters.push("type = ?")
      params.push(input.type)
    }
    params.push(Math.max(1, Math.min(input.limit ?? 500, 5000)))
    return allRows<StoredEvent>(
      conn,
      `SELECT * FROM obs_events ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY time DESC,event_id DESC LIMIT ?`,
      ...params,
    )
  }

  export function queryMetrics(opts: {
    since: number
    until?: number
    names?: string[]
    module?: string
    scopeID?: string
    sessionID?: string
    tool?: string
    providerID?: string
    traceId?: string
    correlationId?: string
    limit?: number
    newestFirst?: boolean
  }) {
    flush()
    const conn = queryConnection()
    if (!conn) return [] as StoredMetric[]
    const filters = ["time >= ?"]
    const params: Array<string | number> = [opts.since]
    if (opts.until !== undefined) {
      filters.push("time < ?")
      params.push(opts.until)
    }
    if (opts.names?.length) {
      filters.push(`name IN (${opts.names.map(() => "?").join(",")})`)
      params.push(...opts.names)
    }
    if (opts.module) {
      filters.push("module = ?")
      params.push(opts.module)
    }
    if (opts.scopeID) {
      filters.push("scope_id = ?")
      params.push(opts.scopeID)
    }
    if (opts.sessionID) {
      filters.push("session_id = ?")
      params.push(opts.sessionID)
    }
    if (opts.tool) {
      filters.push("tool = ?")
      params.push(opts.tool)
    }
    if (opts.traceId) {
      filters.push("trace_id = ?")
      params.push(opts.traceId)
    }
    if (opts.correlationId) {
      filters.push("correlation_id = ?")
      params.push(opts.correlationId)
    }
    if (opts.providerID) {
      filters.push("(json_extract(labels_json, '$.providerID') = ? OR json_extract(labels_json, '$.provider') = ?)")
      params.push(opts.providerID, opts.providerID)
    }
    params.push(opts.limit ?? 10_000)
    const order = opts.newestFirst ? "time DESC, metric_id DESC" : "time ASC, metric_id ASC"
    return allRows<StoredMetric>(
      conn,
      `SELECT * FROM obs_metrics WHERE ${filters.join(" AND ")} ORDER BY ${order} LIMIT ?`,
      ...params,
    )
  }

  export function queryMetricSeries(
    opts: Omit<Parameters<typeof queryMetrics>[0], "names" | "limit" | "newestFirst"> & {
      name: string
      limit?: number
    },
  ) {
    return queryMetrics({ ...opts, names: [opts.name], limit: opts.limit ?? 50_000, newestFirst: true })
  }

  export function querySpans(opts: {
    since?: number
    until?: number
    activeSince?: number
    traceId?: string
    correlationId?: string
    limit?: number
    minDurationMs?: number
    status?: string
    scopeID?: string
    sessionID?: string
    module?: string
    kind?: string
    kinds?: string[]
    distinctTrace?: boolean
  }) {
    flush()
    const conn = queryConnection()
    if (!conn) return [] as StoredSpan[]
    const filters: string[] = []
    const params: Array<string | number> = []
    if (opts.since !== undefined) {
      filters.push("start_time >= ?")
      params.push(opts.since)
    }
    if (opts.activeSince !== undefined) {
      filters.push("last_activity_time >= ?")
      params.push(opts.activeSince)
    }
    if (opts.until !== undefined) {
      filters.push("start_time <= ?")
      params.push(opts.until)
    }
    if (opts.traceId) {
      filters.push("trace_id = ?")
      params.push(opts.traceId)
    }
    if (opts.correlationId) {
      filters.push("correlation_id = ?")
      params.push(opts.correlationId)
    }
    if (opts.minDurationMs !== undefined) {
      filters.push("duration_ms >= ?")
      params.push(opts.minDurationMs)
    }
    if (opts.status) {
      filters.push("status = ?")
      params.push(opts.status)
    }
    if (opts.scopeID) {
      filters.push("scope_id = ?")
      params.push(opts.scopeID)
    }
    if (opts.sessionID) {
      filters.push("session_id = ?")
      params.push(opts.sessionID)
    }
    if (opts.module) {
      filters.push("module = ?")
      params.push(opts.module)
    }
    if (opts.kind) {
      filters.push("kind = ?")
      params.push(opts.kind)
    }
    if (opts.kinds?.length) {
      filters.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`)
      params.push(...opts.kinds)
    }
    params.push(opts.limit ?? 1000)
    if (opts.distinctTrace) {
      return allRows<StoredSpan>(
        conn,
        `SELECT * FROM (
             SELECT *, ROW_NUMBER() OVER (PARTITION BY trace_id ORDER BY start_time ASC,span_id ASC) AS trace_rank
             FROM obs_spans ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
           ) WHERE trace_rank = 1 ORDER BY start_time DESC LIMIT ?`,
        ...params,
      )
    }
    return allRows<StoredSpan>(
      conn,
      `SELECT * FROM obs_spans ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY start_time DESC LIMIT ?`,
      ...params,
    )
  }

  export function queryInflight(
    opts: { activeSince?: number; limit?: number; staleMs?: number; scopeID?: string; sessionID?: string } = {},
  ) {
    const rows = querySpans({
      activeSince: opts.activeSince,
      status: "running",
      scopeID: opts.scopeID,
      sessionID: opts.sessionID,
      limit: opts.limit ?? 100,
    })
    const now = Date.now()
    const staleMs = opts.staleMs ?? ObservabilityConfig.current().thresholds.slowToolMs ?? 30_000
    return rows.map((row) => ({
      ...row,
      age_ms: now - row.start_time,
      idle_ms: now - (row.last_activity_time ?? row.start_time),
      stale: now - (row.last_activity_time ?? row.start_time) >= staleMs,
    }))
  }

  export function interruptRunningSpans(opts: { reason: "previous_runtime_ended" | "runtime_shutdown" }) {
    if (!inlineMode()) {
      flush()
      ObservabilityTelemetryClient.sendInterruptSpans(opts.reason)
      return 0
    }
    flush()
    const conn = open()
    if (!conn) return 0
    return ObservabilityDbWrites.interruptRunningSpans(conn, opts.reason)
  }

  export function queryIssues(
    opts: {
      status?: string
      severity?: string
      module?: string
      scopeID?: string
      tool?: string
      since?: number
      until?: number
      limit?: number
    } = {},
  ) {
    flush()
    const conn = queryConnection()
    if (!conn) return [] as StoredIssue[]
    const filters: string[] = []
    const params: Array<string | number> = []
    if (opts.status) {
      filters.push("status = ?")
      params.push(opts.status)
    }
    if (opts.severity) {
      filters.push("severity = ?")
      params.push(opts.severity)
    }
    if (opts.module) {
      filters.push("module = ?")
      params.push(opts.module)
    }
    if (opts.tool) {
      filters.push("json_extract(evidence_json, '$.tool') = ?")
      params.push(opts.tool)
    }
    if (opts.since !== undefined) {
      filters.push("last_seen_time >= ?")
      params.push(opts.since)
    }
    if (opts.until !== undefined) {
      filters.push("last_seen_time < ?")
      params.push(opts.until)
    }
    if (opts.scopeID) {
      filters.push("(scope_id = ? OR json_extract(evidence_json, '$.scopeID') = ?)")
      params.push(opts.scopeID, opts.scopeID)
    }
    params.push(opts.limit ?? 50)
    return allRows<StoredIssue>(
      conn,
      `SELECT * FROM obs_issues ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY last_seen_time DESC LIMIT ?`,
      ...params,
    )
  }
  export function countIssues(opts: { status?: string; scopeID?: string; since?: number; until?: number } = {}) {
    flush()
    const conn = queryConnection()
    if (!conn) return { total: 0, info: 0, warning: 0, error: 0, critical: 0 }
    const filters: string[] = []
    const params: Array<string | number> = []
    if (opts.status) {
      filters.push("status = ?")
      params.push(opts.status)
    }
    if (opts.since !== undefined) {
      filters.push("last_seen_time >= ?")
      params.push(opts.since)
    }
    if (opts.until !== undefined) {
      filters.push("last_seen_time < ?")
      params.push(opts.until)
    }
    if (opts.scopeID) {
      filters.push("(scope_id = ? OR json_extract(evidence_json, '$.scopeID') = ?)")
      params.push(opts.scopeID, opts.scopeID)
    }
    const rows = allRows<{ severity: ObservabilitySchema.IssueSeverity; count: number }>(
      conn,
      `SELECT severity, COUNT(*) AS count FROM obs_issues ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} GROUP BY severity`,
      ...params,
    )
    const result = { total: 0, info: 0, warning: 0, error: 0, critical: 0 }
    for (const row of rows) {
      result[row.severity] += row.count
      result.total += row.count
    }
    return result
  }

  export function latestResource(opts: { scopeID?: string } = {}) {
    flush()
    const conn = queryConnection()
    if (!conn) return undefined
    if (opts.scopeID) {
      return getRow<StoredResource>(
        conn,
        "SELECT * FROM obs_resource_samples WHERE scope_id = ? ORDER BY time DESC LIMIT 1",
        opts.scopeID,
      )
    }
    return getRow<StoredResource>(conn, "SELECT * FROM obs_resource_samples ORDER BY time DESC LIMIT 1")
  }

  export function resourceSince(since: number, opts: { scopeID?: string; limit?: number; newestFirst?: boolean } = {}) {
    flush()
    const limit = opts.limit ?? 10_000
    const conn = queryConnection()
    if (!conn) return []
    if (opts.scopeID) {
      return allRows<StoredResource>(
        conn,
        `SELECT * FROM obs_resource_samples WHERE time >= ? AND scope_id = ? ORDER BY time ${opts.newestFirst ? "DESC" : "ASC"} LIMIT ?`,
        since,
        opts.scopeID,
        limit,
      )
    }
    return allRows<StoredResource>(
      conn,
      `SELECT * FROM obs_resource_samples WHERE time >= ? ORDER BY time ${opts.newestFirst ? "DESC" : "ASC"} LIMIT ?`,
      since,
      limit,
    )
  }

  export function retain(now = Date.now()) {
    if (!inlineMode()) {
      flush()
      ObservabilityTelemetryClient.sendRetainNow()
      return
    }
    const conn = open()
    if (!conn) return
    const config = ObservabilityConfig.current()
    ObservabilityDbWrites.retain(conn, now, now - config.metricRetentionMs, now - config.traceRetentionMs)
    enforceMaxSize(conn, config.storage.maxSqliteBytes)
  }

  export function flush() {
    for (const hook of beforeFlushHooks) hook()
    if (!inlineMode()) {
      if (flushTimer) clearTimeout(flushTimer)
      flushTimer = undefined
      ObservabilityTelemetryClient.flushPending()
      return
    }
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = undefined
    if (!pending.length) return
    const conn = open()
    if (!conn) {
      droppedJobs += pending.length
      pending.length = 0
      return
    }
    const jobs = pending.splice(0, pending.length)
    try {
      conn.transaction(() => {
        for (const job of jobs) job()
      })()
    } catch {
      droppedJobs += jobs.length
      return
    }
    if (retentionQueued) {
      retentionQueued = false
      retain()
    } else {
      enforceMaxSize(conn, ObservabilityConfig.current().storage.maxSqliteBytes)
    }
  }

  export function meta() {
    const conn = queryConnection()
    return conn ? allRows<ObservabilityMetaRow>(conn, "SELECT key,value FROM obs_meta ORDER BY key ASC") : []
  }

  export function initializeForMigration() {
    // Migration runs before the worker starts, so it always uses the inline
    // write connection regardless of the runtime mode.
    if (db) return db
    const conn = createConnection()
    db = conn
    return conn
  }

  export function enableIncrementalVacuumForMigration() {
    const conn = initializeForMigration()
    ObservabilitySqliteMaintenance.enableIncrementalVacuum(conn)
  }

  function createConnection() {
    fsSync.mkdirSync(ObservabilityPaths.dir(), { recursive: true })
    const fresh = !fsSync.existsSync(ObservabilityPaths.pathName())
    const conn = new Database(ObservabilityPaths.pathName(), { create: true })
    ObservabilityDbSchema.configureWriteConnection(conn, fresh)
    return conn
  }

  function checkpointSafely() {
    const conn = open()
    if (!conn) return
    checkpointConnectionSafely(conn)
  }

  function maintainSizeSafely() {
    try {
      const conn = open()
      if (!conn) return
      enforceMaxSize(conn, ObservabilityConfig.current().storage.maxSqliteBytes)
    } catch {}
  }

  function checkpointConnectionSafely(conn: Database) {
    try {
      checkpointConnection(conn)
    } catch {}
  }

  function checkpointConnection(conn: Database) {
    ObservabilityDbWrites.checkpoint(conn)
  }

  function enqueue(job: () => void) {
    if (!ObservabilityConfig.current().enabled) return
    if (pending.length >= MAX_PENDING) {
      const dropCount = Math.max(1, Math.floor(MAX_PENDING / 10))
      pending.splice(0, dropCount)
      droppedJobs += dropCount
    }
    pending.push(job)
    if (!flushTimer) {
      flushTimer = setTimeout(flush, FLUSH_MS)
      flushTimer.unref()
    }
  }

  function queueRetention() {
    retentionQueued = true
    if (!flushTimer) {
      flushTimer = setTimeout(flush, FLUSH_MS)
      flushTimer.unref()
    }
  }

  function enforceMaxSize(conn: Database, maxBytes: number) {
    try {
      const result = ObservabilitySqliteMaintenance.enforce({
        db: conn,
        path: pathName(),
        maxBytes,
        tables: ObservabilityDbSchema.SIZE_CAP_TABLES,
        budgetMs: 500,
      })
      capExceededBytes = result.capExceededBytes
      maintenanceDeferred = result.deferred ?? false
    } catch {}
  }

  type SqlBinding = string | number | bigint | boolean | null | Uint8Array

  function allRows<Row>(conn: Database, sql: string, ...params: SqlBinding[]): Row[] {
    const statement = conn.prepare(sql)
    try {
      return statement.all(...params) as Row[]
    } finally {
      statement.finalize()
    }
  }

  function getRow<Row>(conn: Database, sql: string, ...params: SqlBinding[]): Row | undefined {
    const statement = conn.prepare(sql)
    try {
      return statement.get(...params) as Row | undefined
    } finally {
      statement.finalize()
    }
  }

  export interface StoredMetric {
    metric_id: string
    time: number
    name: string
    value: number
    unit: ObservabilitySchema.Unit
    source: ObservabilitySchema.Source
    module: ObservabilitySchema.Module
    correlation_id?: string | null
    scope_id?: string | null
    session_id?: string | null
    message_id?: string | null
    call_id?: string | null
    trace_id?: string | null
    span_id?: string | null
    parent_span_id?: string | null
    rid?: string | null
    process_id?: string | null
    pid?: number | null
    tool?: string | null
    labels_json: string
    sample_rate: number
  }

  export interface StoredSpan {
    trace_id: string
    correlation_id?: string | null
    span_id: string
    parent_span_id?: string | null
    kind: ObservabilitySchema.SpanKind
    name: string
    module: ObservabilitySchema.Module
    source: ObservabilitySchema.Source
    start_time: number
    end_time?: number | null
    duration_ms?: number | null
    last_activity_time?: number | null
    heartbeat_time?: number | null
    heartbeat_count?: number | null
    stalled?: number | null
    status: ObservabilitySchema.SpanStatus
    error_code?: string | null
    error_message?: string | null
    scope_id?: string | null
    session_id?: string | null
    message_id?: string | null
    call_id?: string | null
    rid?: string | null
    process_id?: string | null
    pid?: number | null
    tool?: string | null
    attributes_json: string
    redaction_json?: string | null
  }

  export interface StoredEvent {
    event_id: string
    time: number
    iso: string
    type: string
    level?: ObservabilitySchema.EventLevel | null
    correlation_id?: string | null
    trace_id?: string | null
    span_id?: string | null
    parent_span_id?: string | null
    session_id?: string | null
    message_id?: string | null
    call_id?: string | null
    tool?: string | null
    process_id?: string | null
    pid?: number | null
    cwd?: string | null
    scope_id?: string | null
    rid?: string | null
    source: ObservabilitySchema.Source
    module: ObservabilitySchema.Module
    data_json: string
    redaction_json?: string | null
  }

  export interface StoredResource {
    sample_id: string
    time: number
    iso: string
    source: ObservabilitySchema.Source
    correlation_id?: string | null
    trace_id?: string | null
    scope_id?: string | null
    session_id?: string | null
    pid?: number | null
    process_id?: string | null
    process_role?: string | null
    cpu_user_micros?: number | null
    cpu_system_micros?: number | null
    cpu_utilization_ratio?: number | null
    memory_rss_bytes?: number | null
    memory_heap_total_bytes?: number | null
    memory_heap_used_bytes?: number | null
    memory_external_bytes?: number | null
    memory_array_buffers_bytes?: number | null
    event_loop_lag_ms?: number | null
    event_loop_sample_window_ms?: number | null
    app_read_bytes?: number | null
    app_written_bytes?: number | null
    app_read_ops?: number | null
    app_write_ops?: number | null
    os_read_bytes?: number | null
    os_written_bytes?: number | null
    os_available?: number | null
    cgroup_current_bytes?: number | null
    cgroup_high_bytes?: number | null
    cgroup_max_bytes?: number | null
    cgroup_peak_bytes?: number | null
    cgroup_oom_count?: number | null
    cgroup_oom_kill_count?: number | null
    service_memory_rss_bytes?: number | null
    service_memory_source?: "cgroup_v2" | "process_api" | null
    service_memory_completeness?: "full" | "partial" | null
    labels_json?: string | null
    redaction_json?: string | null
  }

  export interface StoredIssue {
    issue_id: string
    time: number
    iso: string
    severity: ObservabilitySchema.IssueSeverity
    status: ObservabilitySchema.IssueStatus
    code: string
    title: string
    message: string
    recommendation?: string | null
    module: ObservabilitySchema.Module
    correlation_id?: string | null
    trace_id?: string | null
    span_id?: string | null
    scope_id?: string | null
    session_id?: string | null
    message_id?: string | null
    call_id?: string | null
    rid?: string | null
    evidence_json: string
    first_seen_time: number
    last_seen_time: number
    occurrence_count: number
    fingerprint: string
    redaction_json?: string | null
  }

  export interface ObservabilityMetaRow {
    key: string
    value: string
  }
}
