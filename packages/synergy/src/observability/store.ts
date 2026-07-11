import { Database } from "bun:sqlite"
import fsSync from "fs"
import path from "path"
import { Global } from "@/global"
import { ObservabilityConfig } from "@/observability/config"
import { ObservabilitySchema } from "./schema"
import { ObservabilitySqliteMaintenance } from "./sqlite-maintenance"

export namespace ObservabilityStore {
  const SCHEMA_VERSION = "4"
  const MAX_PENDING = 10_000
  const FLUSH_MS = 1000
  const SIZE_CAP_TABLES = [
    { table: "obs_metrics", orderBy: "time" },
    { table: "obs_events", orderBy: "time" },
    { table: "obs_resource_samples", orderBy: "time" },
    { table: "obs_browser_batches", orderBy: "received_time" },
    { table: "obs_spans", orderBy: "start_time", where: "status != 'running'" },
    { table: "obs_issues", orderBy: "last_seen_time", where: "status != 'open'" },
  ] as const
  let db: Database | undefined
  let checkpointTimer: ReturnType<typeof setInterval> | undefined
  let compactTimer: ReturnType<typeof setInterval> | undefined
  let retentionTimer: ReturnType<typeof setInterval> | undefined
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let retentionQueued = false
  let droppedJobs = 0
  let lastOpenError: string | undefined
  let openFailed = false
  let capExceededBytes = 0
  let checkpointIntervalMs: number | undefined
  let retentionIntervalMs: number | undefined
  const pending: Array<() => void> = []
  const beforeFlushHooks = new Set<() => void>()

  export function stats() {
    return {
      pending: pending.length,
      dropped: droppedJobs,
      available: !!db,
      lastOpenError,
      capExceededBytes,
      checkpointIntervalMs,
      retentionIntervalMs,
    }
  }

  export function beforeFlush(hook: () => void) {
    beforeFlushHooks.add(hook)
    return () => beforeFlushHooks.delete(hook)
  }

  export function dir() {
    return path.join(Global.Path.state, "observability")
  }

  export function pathName() {
    return path.join(dir(), "observability.sqlite")
  }

  export function legacyPerformancePath() {
    return path.join(dir(), "performance", "performance.sqlite")
  }

  export function open(): Database | undefined {
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
    flush()
    if (db) checkpointConnectionSafely(db)
    clearTimers()
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
    const conn = open()
    if (!conn) return
    checkpointConnection(conn)
  }

  export function insertMetric(metric: ObservabilitySchema.Metric) {
    enqueue(() => insertMetricSync(metric))
  }

  export function insertSpan(span: ObservabilitySchema.Span) {
    enqueue(() => upsertSpanSync(span))
  }

  export function updateSpan(span: ObservabilitySchema.Span) {
    enqueue(() => upsertSpanSync(span))
  }

  export function insertEvent(event: ObservabilitySchema.Event) {
    enqueue(() => insertEventSync(event))
  }

  export function insertResource(sample: ObservabilitySchema.ResourceSample) {
    enqueue(() => insertResourceSync(sample))
  }

  export function insertIssue(issue: ObservabilitySchema.Issue) {
    enqueue(() => insertIssueSync(issue))
  }

  export function insertBrowserBatch(input: {
    batchId: string
    receivedTime: number
    sentAt: number
    accepted: number
    rejected: number
    page: Record<string, unknown>
  }) {
    enqueue(() => insertBrowserBatchSync(input))
  }

  export function queryEvents(input: ObservabilitySchema.Query = {}) {
    flush()
    const conn = open()
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
    return conn
      .prepare(
        `SELECT * FROM obs_events ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY time DESC,event_id DESC LIMIT ?`,
      )
      .all(...params) as StoredEvent[]
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
    const conn = open()
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
    return conn
      .prepare(`SELECT * FROM obs_metrics WHERE ${filters.join(" AND ")} ORDER BY ${order} LIMIT ?`)
      .all(...params) as StoredMetric[]
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
    const conn = open()
    if (!conn) return [] as StoredSpan[]
    const filters: string[] = []
    const params: Array<string | number> = []
    if (opts.since !== undefined) {
      filters.push("start_time >= ?")
      params.push(opts.since)
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
      return conn
        .prepare(
          `SELECT * FROM (
             SELECT *, ROW_NUMBER() OVER (PARTITION BY trace_id ORDER BY start_time ASC,span_id ASC) AS trace_rank
             FROM obs_spans ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
           ) WHERE trace_rank = 1 ORDER BY start_time DESC LIMIT ?`,
        )
        .all(...params) as StoredSpan[]
    }
    return conn
      .prepare(
        `SELECT * FROM obs_spans ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY start_time DESC LIMIT ?`,
      )
      .all(...params) as StoredSpan[]
  }

  export function queryInflight(opts: { limit?: number; staleMs?: number; scopeID?: string; sessionID?: string } = {}) {
    const rows = querySpans({
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

  export function queryIssues(
    opts: { status?: string; severity?: string; module?: string; scopeID?: string; limit?: number } = {},
  ) {
    flush()
    const conn = open()
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
    if (opts.scopeID) {
      filters.push("(scope_id = ? OR json_extract(evidence_json, '$.scopeID') = ?)")
      params.push(opts.scopeID, opts.scopeID)
    }
    params.push(opts.limit ?? 50)
    return conn
      .prepare(
        `SELECT * FROM obs_issues ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY last_seen_time DESC LIMIT ?`,
      )
      .all(...params) as StoredIssue[]
  }

  export function latestResource(opts: { scopeID?: string } = {}) {
    flush()
    if (opts.scopeID) {
      return open()
        ?.prepare("SELECT * FROM obs_resource_samples WHERE scope_id = ? ORDER BY time DESC LIMIT 1")
        .get(opts.scopeID) as StoredResource | undefined
    }
    return open()?.prepare("SELECT * FROM obs_resource_samples ORDER BY time DESC LIMIT 1").get() as
      | StoredResource
      | undefined
  }

  export function resourceSince(since: number, opts: { scopeID?: string; limit?: number } = {}) {
    flush()
    const limit = opts.limit ?? 10_000
    if (opts.scopeID) {
      return (
        (open()
          ?.prepare("SELECT * FROM obs_resource_samples WHERE time >= ? AND scope_id = ? ORDER BY time ASC LIMIT ?")
          .all(since, opts.scopeID, limit) as StoredResource[] | undefined) ?? []
      )
    }
    return (
      (open()
        ?.prepare("SELECT * FROM obs_resource_samples WHERE time >= ? ORDER BY time ASC LIMIT ?")
        .all(since, limit) as StoredResource[] | undefined) ?? []
    )
  }

  export function retain(now = Date.now()) {
    const conn = open()
    if (!conn) return
    const config = ObservabilityConfig.current()
    const metricCutoff = now - config.metricRetentionMs
    const traceCutoff = now - config.traceRetentionMs
    conn.prepare("DELETE FROM obs_metrics WHERE time < ?").run(metricCutoff)
    conn.prepare("DELETE FROM obs_events WHERE time < ?").run(traceCutoff)
    conn.prepare("DELETE FROM obs_resource_samples WHERE time < ?").run(metricCutoff)
    conn.prepare("DELETE FROM obs_spans WHERE start_time < ? AND status != 'running'").run(traceCutoff)
    conn.prepare("DELETE FROM obs_browser_batches WHERE received_time < ?").run(metricCutoff)
    conn.prepare("DELETE FROM obs_issues WHERE status != 'open' AND time < ?").run(traceCutoff)
    conn.prepare("INSERT OR REPLACE INTO obs_meta (key,value) VALUES ('lastRetentionRunAt', ?)").run(String(now))
    enforceMaxSize(conn, config.storage.maxSqliteBytes)
  }

  export function flush() {
    for (const hook of beforeFlushHooks) hook()
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
    return (
      (open()?.prepare("SELECT key,value FROM obs_meta ORDER BY key ASC").all() as
        | ObservabilityMetaRow[]
        | undefined) ?? []
    )
  }

  export function initializeForMigration() {
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
    fsSync.mkdirSync(dir(), { recursive: true })
    const fresh = !fsSync.existsSync(pathName())
    const conn = new Database(pathName(), { create: true })
    if (fresh) conn.exec("PRAGMA auto_vacuum=INCREMENTAL")
    conn.exec("PRAGMA journal_mode=WAL")
    conn.exec("PRAGMA busy_timeout=5000")
    conn.exec("PRAGMA foreign_keys=ON")
    initialize(conn)
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
    conn
      .prepare("INSERT OR REPLACE INTO obs_meta (key,value) VALUES ('lastWalCheckpointAt', ?)")
      .run(String(Date.now()))
    conn.exec("PRAGMA wal_checkpoint(TRUNCATE)")
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

  function insertMetricSync(metric: ObservabilitySchema.Metric) {
    open()
      ?.query(
        `INSERT OR REPLACE INTO obs_metrics (metric_id,time,iso,name,value,unit,source,module,correlation_id,scope_id,session_id,message_id,call_id,trace_id,span_id,parent_span_id,rid,process_id,pid,tool,labels_json,sample_rate,redaction_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)`,
      )
      .run(
        metric.metricId,
        metric.time,
        metric.iso,
        metric.name,
        metric.value,
        metric.unit,
        metric.source,
        metric.module,
        metric.correlationId ?? null,
        metric.scopeID ?? null,
        metric.sessionID ?? null,
        metric.messageID ?? null,
        metric.callID ?? null,
        metric.traceId ?? null,
        metric.spanId ?? null,
        metric.parentSpanId ?? null,
        metric.rid ?? null,
        metric.processId ?? null,
        metric.pid ?? null,
        metric.tool ?? null,
        JSON.stringify(metric.labels ?? {}),
        metric.sampleRate,
        JSON.stringify(metric.redaction),
      )
  }

  function upsertSpanSync(span: ObservabilitySchema.Span) {
    open()
      ?.query(
        `INSERT INTO obs_spans (trace_id,correlation_id,span_id,parent_span_id,kind,name,module,source,start_time,end_time,duration_ms,last_activity_time,heartbeat_time,heartbeat_count,stalled,status,error_code,error_message,scope_id,session_id,message_id,call_id,rid,process_id,pid,tool,attributes_json,redaction_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28)
         ON CONFLICT(span_id) DO UPDATE SET trace_id=excluded.trace_id,correlation_id=excluded.correlation_id,parent_span_id=excluded.parent_span_id,kind=excluded.kind,name=excluded.name,module=excluded.module,source=excluded.source,start_time=excluded.start_time,end_time=excluded.end_time,duration_ms=excluded.duration_ms,last_activity_time=excluded.last_activity_time,heartbeat_time=excluded.heartbeat_time,heartbeat_count=excluded.heartbeat_count,stalled=excluded.stalled,status=excluded.status,error_code=excluded.error_code,error_message=excluded.error_message,scope_id=excluded.scope_id,session_id=excluded.session_id,message_id=excluded.message_id,call_id=excluded.call_id,rid=excluded.rid,process_id=excluded.process_id,pid=excluded.pid,tool=excluded.tool,attributes_json=excluded.attributes_json,redaction_json=excluded.redaction_json`,
      )
      .run(
        span.traceId,
        span.correlationId ?? null,
        span.spanId,
        span.parentSpanId ?? null,
        span.kind,
        span.name,
        span.module,
        span.source,
        span.startTime,
        span.endTime ?? null,
        span.durationMs ?? null,
        span.lastActivityTime,
        span.heartbeatTime ?? null,
        span.heartbeatCount,
        span.stalled ? 1 : 0,
        span.status,
        span.errorCode ?? null,
        span.errorMessage ?? null,
        span.scopeID ?? null,
        span.sessionID ?? null,
        span.messageID ?? null,
        span.callID ?? null,
        span.rid ?? null,
        span.processId ?? null,
        span.pid ?? null,
        span.tool ?? null,
        JSON.stringify(span.attributes ?? {}),
        JSON.stringify(span.redaction),
      )
  }

  function insertEventSync(event: ObservabilitySchema.Event) {
    open()
      ?.query(
        `INSERT OR REPLACE INTO obs_events (event_id,time,iso,type,level,correlation_id,trace_id,span_id,parent_span_id,session_id,message_id,call_id,tool,process_id,pid,cwd,scope_id,rid,source,module,data_json,redaction_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)`,
      )
      .run(
        event.eventId,
        event.time,
        event.iso,
        event.type,
        event.level ?? null,
        event.correlationId ?? null,
        event.traceId ?? null,
        event.spanId ?? null,
        event.parentSpanId ?? null,
        event.sessionID ?? null,
        event.messageID ?? null,
        event.callID ?? null,
        event.tool ?? null,
        event.processId ?? null,
        event.pid ?? null,
        event.cwd ?? null,
        event.scopeID ?? null,
        event.rid ?? null,
        event.source,
        event.module,
        JSON.stringify(event.data ?? {}),
        JSON.stringify(event.redaction),
      )
  }

  function insertResourceSync(sample: ObservabilitySchema.ResourceSample) {
    open()
      ?.query(
        `INSERT OR REPLACE INTO obs_resource_samples (sample_id,time,iso,source,correlation_id,trace_id,scope_id,session_id,pid,process_id,process_role,cpu_user_micros,cpu_system_micros,cpu_utilization_ratio,memory_rss_bytes,memory_heap_total_bytes,memory_heap_used_bytes,memory_external_bytes,memory_array_buffers_bytes,event_loop_lag_ms,event_loop_sample_window_ms,app_read_bytes,app_written_bytes,app_read_ops,app_write_ops,os_read_bytes,os_written_bytes,os_available,labels_json,redaction_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30)`,
      )
      .run(
        sample.sampleId,
        sample.time,
        sample.iso,
        sample.source,
        sample.correlationId ?? null,
        sample.traceId ?? null,
        sample.scopeID ?? null,
        sample.sessionID ?? null,
        sample.process.pid ?? null,
        sample.process.processId ?? null,
        sample.process.role,
        sample.cpu.userMicros ?? null,
        sample.cpu.systemMicros ?? null,
        sample.cpu.utilizationRatio ?? null,
        sample.memory.rssBytes ?? null,
        sample.memory.heapTotalBytes ?? null,
        sample.memory.heapUsedBytes ?? null,
        sample.memory.externalBytes ?? null,
        sample.memory.arrayBuffersBytes ?? null,
        sample.eventLoop.lagMs ?? null,
        sample.eventLoop.sampleWindowMs,
        sample.io.appReadBytes ?? null,
        sample.io.appWrittenBytes ?? null,
        sample.io.appReadOps ?? null,
        sample.io.appWriteOps ?? null,
        sample.io.osReadBytes ?? null,
        sample.io.osWrittenBytes ?? null,
        sample.io.osAvailable ? 1 : 0,
        JSON.stringify(sample.labels ?? {}),
        JSON.stringify(sample.redaction),
      )
  }

  function insertIssueSync(issue: ObservabilitySchema.Issue) {
    open()
      ?.query(
        `INSERT INTO obs_issues (issue_id,time,iso,severity,status,code,title,message,recommendation,module,correlation_id,trace_id,span_id,scope_id,session_id,message_id,call_id,rid,evidence_json,first_seen_time,last_seen_time,occurrence_count,fingerprint,redaction_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)
         ON CONFLICT(fingerprint) WHERE status = 'open' DO UPDATE SET last_seen_time=excluded.last_seen_time, occurrence_count=obs_issues.occurrence_count+1, evidence_json=excluded.evidence_json, redaction_json=excluded.redaction_json`,
      )
      .run(
        issue.issueId,
        issue.time,
        issue.iso,
        issue.severity,
        issue.status,
        issue.code,
        issue.title,
        issue.message,
        issue.recommendation ?? null,
        issue.module,
        issue.correlationId ?? null,
        issue.traceId ?? null,
        issue.spanId ?? null,
        issue.scopeID ?? null,
        issue.sessionID ?? null,
        issue.messageID ?? null,
        issue.callID ?? null,
        issue.rid ?? null,
        JSON.stringify(issue.evidence ?? {}),
        issue.firstSeenTime,
        issue.lastSeenTime,
        issue.occurrenceCount,
        issue.fingerprint,
        JSON.stringify(issue.redaction),
      )
  }

  function insertBrowserBatchSync(input: {
    batchId: string
    receivedTime: number
    sentAt: number
    accepted: number
    rejected: number
    page: Record<string, unknown>
  }) {
    open()
      ?.query(
        `INSERT OR REPLACE INTO obs_browser_batches (batch_id,received_time,sent_at,source,accepted,rejected,page_json) VALUES (?1,?2,?3,'browser',?4,?5,?6)`,
      )
      .run(input.batchId, input.receivedTime, input.sentAt, input.accepted, input.rejected, JSON.stringify(input.page))
  }

  function enforceMaxSize(conn: Database, maxBytes: number) {
    try {
      capExceededBytes = ObservabilitySqliteMaintenance.enforce({
        db: conn,
        path: pathName(),
        maxBytes,
        tables: SIZE_CAP_TABLES,
      }).capExceededBytes
    } catch {}
  }

  function initialize(conn: Database) {
    const now = Date.now()
    conn.exec(SQL)
    conn.prepare("INSERT OR IGNORE INTO obs_meta (key,value) VALUES ('schemaVersion', ?)").run(SCHEMA_VERSION)
    conn.prepare("INSERT OR IGNORE INTO obs_meta (key,value) VALUES ('createdAt', ?)").run(new Date(now).toISOString())
    conn.prepare("INSERT OR IGNORE INTO obs_meta (key,value) VALUES ('lastRetentionRunAt', ?)").run(String(now))
    conn.prepare("INSERT OR IGNORE INTO obs_meta (key,value) VALUES ('lastWalCheckpointAt', ?)").run(String(now))
  }

  export interface StoredMetric {
    metric_id: string
    time: number
    iso: string
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
    redaction_json?: string | null
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

  const SQL = `
CREATE TABLE IF NOT EXISTS obs_metrics (metric_id TEXT PRIMARY KEY,time INTEGER NOT NULL,iso TEXT NOT NULL,name TEXT NOT NULL,value REAL NOT NULL,unit TEXT NOT NULL,source TEXT NOT NULL,module TEXT NOT NULL,correlation_id TEXT,scope_id TEXT,session_id TEXT,message_id TEXT,call_id TEXT,trace_id TEXT,span_id TEXT,parent_span_id TEXT,rid TEXT,process_id TEXT,pid INTEGER,tool TEXT,labels_json TEXT NOT NULL DEFAULT '{}',sample_rate REAL NOT NULL DEFAULT 1,redaction_json TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS idx_obs_metrics_time ON obs_metrics(time);
CREATE INDEX IF NOT EXISTS idx_obs_metrics_name_time ON obs_metrics(name,time);
CREATE INDEX IF NOT EXISTS idx_obs_metrics_module_time ON obs_metrics(module,time);
CREATE INDEX IF NOT EXISTS idx_obs_metrics_trace_time ON obs_metrics(trace_id,time);
CREATE INDEX IF NOT EXISTS idx_obs_metrics_correlation_time ON obs_metrics(correlation_id,time);
CREATE INDEX IF NOT EXISTS idx_obs_metrics_session_time ON obs_metrics(session_id,time);
CREATE INDEX IF NOT EXISTS idx_obs_metrics_scope_time ON obs_metrics(scope_id,time);
CREATE TABLE IF NOT EXISTS obs_spans (trace_id TEXT NOT NULL,correlation_id TEXT,span_id TEXT PRIMARY KEY,parent_span_id TEXT,kind TEXT NOT NULL DEFAULT 'runtime',name TEXT NOT NULL,module TEXT NOT NULL,source TEXT NOT NULL,start_time INTEGER NOT NULL,end_time INTEGER,duration_ms REAL,last_activity_time INTEGER NOT NULL,heartbeat_time INTEGER,heartbeat_count INTEGER NOT NULL DEFAULT 0,stalled INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'running',error_code TEXT,error_message TEXT,scope_id TEXT,session_id TEXT,message_id TEXT,call_id TEXT,rid TEXT,process_id TEXT,pid INTEGER,tool TEXT,attributes_json TEXT NOT NULL DEFAULT '{}',redaction_json TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS idx_obs_spans_trace ON obs_spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_obs_spans_correlation_time ON obs_spans(correlation_id,start_time);
CREATE INDEX IF NOT EXISTS idx_obs_spans_start_time ON obs_spans(start_time);
CREATE INDEX IF NOT EXISTS idx_obs_spans_status_start ON obs_spans(status,start_time);
CREATE INDEX IF NOT EXISTS idx_obs_spans_last_activity ON obs_spans(last_activity_time);
CREATE INDEX IF NOT EXISTS idx_obs_spans_module_start ON obs_spans(module,start_time);
CREATE INDEX IF NOT EXISTS idx_obs_spans_session_start ON obs_spans(session_id,start_time);
CREATE INDEX IF NOT EXISTS idx_obs_spans_scope_start ON obs_spans(scope_id,start_time);
CREATE TABLE IF NOT EXISTS obs_events (event_id TEXT PRIMARY KEY,time INTEGER NOT NULL,iso TEXT NOT NULL,type TEXT NOT NULL,level TEXT,correlation_id TEXT,trace_id TEXT,span_id TEXT,parent_span_id TEXT,session_id TEXT,message_id TEXT,call_id TEXT,tool TEXT,process_id TEXT,pid INTEGER,cwd TEXT,scope_id TEXT,rid TEXT,source TEXT NOT NULL,module TEXT NOT NULL,data_json TEXT NOT NULL DEFAULT '{}',redaction_json TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS idx_obs_events_time ON obs_events(time);
CREATE INDEX IF NOT EXISTS idx_obs_events_type_time ON obs_events(type,time);
CREATE INDEX IF NOT EXISTS idx_obs_events_trace_time ON obs_events(trace_id,time);
CREATE INDEX IF NOT EXISTS idx_obs_events_correlation_time ON obs_events(correlation_id,time);
CREATE INDEX IF NOT EXISTS idx_obs_events_session_time ON obs_events(session_id,time);
CREATE INDEX IF NOT EXISTS idx_obs_events_scope_time ON obs_events(scope_id,time);
CREATE TABLE IF NOT EXISTS obs_resource_samples (sample_id TEXT PRIMARY KEY,time INTEGER NOT NULL,iso TEXT NOT NULL,source TEXT NOT NULL,correlation_id TEXT,trace_id TEXT,scope_id TEXT,session_id TEXT,pid INTEGER,process_id TEXT,process_role TEXT NOT NULL DEFAULT 'unknown',cpu_user_micros REAL,cpu_system_micros REAL,cpu_utilization_ratio REAL,memory_rss_bytes INTEGER,memory_heap_total_bytes INTEGER,memory_heap_used_bytes INTEGER,memory_external_bytes INTEGER,memory_array_buffers_bytes INTEGER,event_loop_lag_ms REAL,event_loop_sample_window_ms INTEGER,app_read_bytes INTEGER,app_written_bytes INTEGER,app_read_ops INTEGER,app_write_ops INTEGER,os_read_bytes INTEGER,os_written_bytes INTEGER,os_available INTEGER NOT NULL DEFAULT 0,labels_json TEXT NOT NULL DEFAULT '{}',redaction_json TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS idx_obs_resource_time ON obs_resource_samples(time);
CREATE INDEX IF NOT EXISTS idx_obs_resource_role_time ON obs_resource_samples(process_role,time);
CREATE INDEX IF NOT EXISTS idx_obs_resource_trace_time ON obs_resource_samples(trace_id,time);
CREATE INDEX IF NOT EXISTS idx_obs_resource_correlation_time ON obs_resource_samples(correlation_id,time);
CREATE INDEX IF NOT EXISTS idx_obs_resource_scope_time ON obs_resource_samples(scope_id,time);
CREATE TABLE IF NOT EXISTS obs_issues (issue_id TEXT PRIMARY KEY,time INTEGER NOT NULL,iso TEXT NOT NULL,severity TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',code TEXT NOT NULL,title TEXT NOT NULL,message TEXT NOT NULL,recommendation TEXT,module TEXT NOT NULL,correlation_id TEXT,trace_id TEXT,span_id TEXT,scope_id TEXT,session_id TEXT,message_id TEXT,call_id TEXT,rid TEXT,evidence_json TEXT NOT NULL DEFAULT '{}',first_seen_time INTEGER NOT NULL,last_seen_time INTEGER NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,fingerprint TEXT NOT NULL,redaction_json TEXT NOT NULL DEFAULT '{}');
CREATE UNIQUE INDEX IF NOT EXISTS idx_obs_issues_fingerprint_open ON obs_issues(fingerprint) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_obs_issues_time ON obs_issues(time);
CREATE INDEX IF NOT EXISTS idx_obs_issues_status_severity_time ON obs_issues(status,severity,time);
CREATE INDEX IF NOT EXISTS idx_obs_issues_trace_time ON obs_issues(trace_id,time);
CREATE INDEX IF NOT EXISTS idx_obs_issues_correlation_time ON obs_issues(correlation_id,time);
CREATE INDEX IF NOT EXISTS idx_obs_issues_module_time ON obs_issues(module,time);
CREATE TABLE IF NOT EXISTS obs_browser_batches (batch_id TEXT PRIMARY KEY,received_time INTEGER NOT NULL,sent_at INTEGER NOT NULL,source TEXT NOT NULL,accepted INTEGER NOT NULL,rejected INTEGER NOT NULL,page_json TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS idx_obs_browser_batches_time ON obs_browser_batches(received_time);
CREATE TABLE IF NOT EXISTS obs_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
`
}
