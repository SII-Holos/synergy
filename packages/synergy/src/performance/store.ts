import { Database } from "bun:sqlite"
import fsSync from "fs"
import path from "path"
import { Global } from "../global"
import { PerformanceConfig } from "./config"
import { PerformanceSchema } from "./schema"

export namespace PerformanceStore {
  const DIR = path.join(Global.Path.state, "observability", "performance")
  const DB_PATH = path.join(DIR, "performance.sqlite")
  const SCHEMA_VERSION = "1"
  let db: Database | undefined
  let checkpointTimer: ReturnType<typeof setInterval> | undefined
  let retentionTimer: ReturnType<typeof setInterval> | undefined
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let retentionQueued = false
  const pending: Array<() => void> = []
  const MAX_PENDING = 10_000
  const FLUSH_MS = 1000
  export function dir() {
    return DIR
  }

  export function pathName() {
    return DB_PATH
  }

  export function open(): Database | undefined {
    const config = PerformanceConfig.current()
    if (!config.enabled || !config.storage.sqliteEnabled) return undefined
    if (db) return db
    fsSync.mkdirSync(DIR, { recursive: true })
    const conn = new Database(DB_PATH, { create: true })
    conn.exec("PRAGMA journal_mode=WAL")
    conn.exec("PRAGMA busy_timeout=5000")
    conn.exec("PRAGMA foreign_keys=ON")
    initialize(conn)
    db = conn
    checkpointTimer = setInterval(() => checkpoint().catch(() => {}), config.storage.walCheckpointIntervalMs)
    checkpointTimer.unref()
    retentionTimer = setInterval(() => retain(), Math.max(config.metricRetentionMs / 4, 60_000))
    retentionTimer.unref()
    queueRetention()
    return conn
  }

  export function close() {
    flush()
    if (checkpointTimer) clearInterval(checkpointTimer)
    if (retentionTimer) clearInterval(retentionTimer)
    if (flushTimer) clearTimeout(flushTimer)
    checkpointTimer = undefined
    retentionTimer = undefined
    flushTimer = undefined
    db?.close(false)
    db = undefined
  }

  export async function checkpoint() {
    open()?.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    open()
      ?.prepare("INSERT OR REPLACE INTO perf_meta (key,value) VALUES ('lastWalCheckpointAt', ?)")
      .run(String(Date.now()))
  }

  function insertMetricSync(metric: PerformanceSchema.Metric) {
    const conn = open()
    if (!conn) return
    conn
      .prepare(
        `INSERT OR REPLACE INTO perf_metrics (metric_id,time,iso,name,value,unit,source,module,scope_id,session_id,message_id,call_id,trace_id,span_id,parent_span_id,rid,process_id,pid,tool,labels_json,sample_rate)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)`,
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
      )
  }

  function insertSpanSync(span: PerformanceSchema.Span) {
    const conn = open()
    if (!conn) return
    conn
      .prepare(
        `INSERT OR REPLACE INTO perf_spans (trace_id,span_id,parent_span_id,name,module,source,start_time,end_time,duration_ms,status,error_code,error_message,scope_id,session_id,message_id,call_id,rid,process_id,pid,tool,attributes_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)`,
      )
      .run(
        span.traceId,
        span.spanId,
        span.parentSpanId ?? null,
        span.name,
        span.module,
        span.source,
        span.startTime,
        span.endTime ?? null,
        span.durationMs ?? null,
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
      )
  }

  function insertResourceSync(sample: PerformanceSchema.ResourceSample) {
    const conn = open()
    if (!conn) return
    conn
      .prepare(
        `INSERT OR REPLACE INTO perf_resource_samples (sample_id,time,iso,source,pid,process_id,process_role,cpu_user_micros,cpu_system_micros,cpu_utilization_ratio,memory_rss_bytes,memory_heap_total_bytes,memory_heap_used_bytes,memory_external_bytes,memory_array_buffers_bytes,event_loop_lag_ms,event_loop_sample_window_ms,app_read_bytes,app_written_bytes,app_read_ops,app_write_ops,os_read_bytes,os_written_bytes,os_available,scope_id,session_id,trace_id,labels_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28)`,
      )
      .run(
        sample.sampleId,
        sample.time,
        sample.iso,
        sample.source,
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
        sample.scopeID ?? null,
        sample.sessionID ?? null,
        sample.traceId ?? null,
        JSON.stringify(sample.labels ?? {}),
      )
  }

  function insertIssueSync(issue: PerformanceSchema.Issue) {
    const conn = open()
    if (!conn) return
    conn
      .prepare(
        `INSERT INTO perf_issues (issue_id,time,iso,severity,status,code,title,message,recommendation,module,trace_id,span_id,session_id,message_id,call_id,rid,evidence_json,first_seen_time,last_seen_time,occurrence_count,fingerprint)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)
         ON CONFLICT(fingerprint) WHERE status = 'open' DO UPDATE SET last_seen_time=excluded.last_seen_time, occurrence_count=perf_issues.occurrence_count+1, evidence_json=excluded.evidence_json`,
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
        issue.traceId ?? null,
        issue.spanId ?? null,
        issue.sessionID ?? null,
        issue.messageID ?? null,
        issue.callID ?? null,
        issue.rid ?? null,
        JSON.stringify(issue.evidence ?? {}),
        issue.firstSeenTime,
        issue.lastSeenTime,
        issue.occurrenceCount,
        issue.fingerprint,
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
      ?.prepare(
        `INSERT OR REPLACE INTO perf_browser_batches (batch_id,received_time,sent_at,source,accepted,rejected,page_json) VALUES (?1,?2,?3,'browser',?4,?5,?6)`,
      )
      .run(input.batchId, input.receivedTime, input.sentAt, input.accepted, input.rejected, JSON.stringify(input.page))
  }

  export function insertMetric(metric: PerformanceSchema.Metric) {
    enqueue(() => insertMetricSync(metric))
  }

  export function insertSpan(span: PerformanceSchema.Span) {
    enqueue(() => insertSpanSync(span))
  }

  export function insertResource(sample: PerformanceSchema.ResourceSample) {
    enqueue(() => insertResourceSync(sample))
  }

  export function insertIssue(issue: PerformanceSchema.Issue) {
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

  export function queryMetrics(opts: {
    since: number
    names?: string[]
    module?: string
    scopeID?: string
    sessionID?: string
    tool?: string
    limit?: number
  }) {
    flush()
    const conn = open()
    if (!conn) return [] as StoredMetric[]
    const filters = ["time >= ?"]
    const params: Array<string | number> = [opts.since]
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
    params.push(opts.limit ?? 10_000)
    return conn
      .prepare(`SELECT * FROM perf_metrics WHERE ${filters.join(" AND ")} ORDER BY time ASC LIMIT ?`)
      .all(...params) as StoredMetric[]
  }

  export function querySpans(opts: {
    since?: number
    until?: number
    traceId?: string
    limit?: number
    minDurationMs?: number
    status?: string
    scopeID?: string
    sessionID?: string
    module?: string
    kind?: string
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
    if (opts.traceId) {
      filters.push("trace_id = ?")
      params.push(opts.traceId)
    }
    if (opts.until !== undefined) {
      filters.push("start_time <= ?")
      params.push(opts.until)
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
    params.push(opts.limit ?? 1000)
    return conn
      .prepare(
        `SELECT * FROM perf_spans ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY start_time DESC LIMIT ?`,
      )
      .all(...params) as StoredSpan[]
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
      filters.push("json_extract(evidence_json, '$.scopeID') = ?")
      params.push(opts.scopeID)
    }
    params.push(opts.limit ?? 50)
    return conn
      .prepare(
        `SELECT * FROM perf_issues ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY last_seen_time DESC LIMIT ?`,
      )
      .all(...params) as StoredIssue[]
  }

  export function latestResource(opts: { scopeID?: string } = {}) {
    flush()
    if (opts.scopeID) {
      return open()
        ?.prepare("SELECT * FROM perf_resource_samples WHERE scope_id = ? ORDER BY time DESC LIMIT 1")
        .get(opts.scopeID) as StoredResource | undefined
    }
    return open()?.prepare("SELECT * FROM perf_resource_samples ORDER BY time DESC LIMIT 1").get() as
      | StoredResource
      | undefined
  }

  export function resourceSince(since: number, opts: { scopeID?: string } = {}) {
    flush()
    if (opts.scopeID) {
      return (
        (open()
          ?.prepare("SELECT * FROM perf_resource_samples WHERE time >= ? AND scope_id = ? ORDER BY time ASC")
          .all(since, opts.scopeID) as StoredResource[] | undefined) ?? []
      )
    }
    return (
      (open()?.prepare("SELECT * FROM perf_resource_samples WHERE time >= ? ORDER BY time ASC").all(since) as
        | StoredResource[]
        | undefined) ?? []
    )
  }

  export function retain(now = Date.now()) {
    const conn = open()
    if (!conn) return
    const config = PerformanceConfig.current()
    const metricCutoff = now - config.metricRetentionMs
    const traceCutoff = now - config.traceRetentionMs
    conn.prepare("DELETE FROM perf_metrics WHERE time < ?").run(metricCutoff)
    conn.prepare("DELETE FROM perf_resource_samples WHERE time < ?").run(metricCutoff)
    conn.prepare("DELETE FROM perf_spans WHERE start_time < ?").run(traceCutoff)
    conn.prepare("DELETE FROM perf_browser_batches WHERE received_time < ?").run(metricCutoff)
    conn.prepare("DELETE FROM perf_issues WHERE status != 'open' AND time < ?").run(traceCutoff)
    enforceMaxSize(conn, config.storage.maxSqliteBytes)
    conn.prepare("INSERT OR REPLACE INTO perf_meta (key,value) VALUES ('lastRetentionRunAt', ?)").run(String(now))
  }

  export function flush() {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = undefined
    if (!pending.length) return
    const conn = open()
    if (!conn) {
      pending.length = 0
      return
    }
    const jobs = pending.splice(0, pending.length)
    conn.transaction(() => {
      for (const job of jobs) job()
    })()
    if (retentionQueued) {
      retentionQueued = false
      retain()
    }
  }

  function enqueue(job: () => void) {
    if (!PerformanceConfig.current().enabled) return
    if (pending.length >= MAX_PENDING) pending.shift()
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
      if (sqliteFootprint() <= maxBytes) return
      for (const table of ["perf_metrics", "perf_resource_samples", "perf_spans", "perf_browser_batches"]) {
        conn
          .prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} ORDER BY rowid ASC LIMIT 1000)`)
          .run()
        conn.exec("PRAGMA wal_checkpoint(TRUNCATE)")
        if (sqliteFootprint() <= maxBytes) break
      }
    } catch {}
  }

  function sqliteFootprint() {
    return [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`].reduce((total, file) => {
      try {
        return total + fsSync.statSync(file).size
      } catch {
        return total
      }
    }, 0)
  }

  function initialize(conn: Database) {
    const now = Date.now()
    conn.exec(SQL)
    conn.prepare("INSERT OR IGNORE INTO perf_meta (key,value) VALUES ('schemaVersion', ?)").run(SCHEMA_VERSION)
    conn.prepare("INSERT OR IGNORE INTO perf_meta (key,value) VALUES ('createdAt', ?)").run(new Date(now).toISOString())
    conn.prepare("INSERT OR IGNORE INTO perf_meta (key,value) VALUES ('lastRetentionRunAt', ?)").run(String(now))
    conn.prepare("INSERT OR IGNORE INTO perf_meta (key,value) VALUES ('lastWalCheckpointAt', ?)").run(String(now))
  }

  export interface StoredMetric {
    metric_id: string
    time: number
    iso: string
    name: string
    value: number
    unit: PerformanceSchema.Unit
    source: PerformanceSchema.Source
    module: PerformanceSchema.Module
    scope_id?: string | null
    session_id?: string | null
    trace_id?: string | null
    span_id?: string | null
    rid?: string | null
    tool?: string | null
    labels_json: string
  }

  export interface StoredSpan {
    trace_id: string
    span_id: string
    parent_span_id?: string | null
    name: string
    module: PerformanceSchema.Module
    source: PerformanceSchema.Source
    start_time: number
    end_time?: number | null
    duration_ms?: number | null
    status: PerformanceSchema.SpanStatus
    error_code?: string | null
    error_message?: string | null
    session_id?: string | null
    rid?: string | null
    tool?: string | null
    attributes_json: string
  }

  export interface StoredResource {
    sample_id: string
    time: number
    iso: string
    source: PerformanceSchema.Source
    pid?: number | null
    cpu_user_micros?: number | null
    cpu_system_micros?: number | null
    cpu_utilization_ratio?: number | null
    memory_rss_bytes?: number | null
    memory_heap_total_bytes?: number | null
    memory_heap_used_bytes?: number | null
    memory_external_bytes?: number | null
    event_loop_lag_ms?: number | null
    app_read_bytes?: number | null
    app_written_bytes?: number | null
    app_read_ops?: number | null
    app_write_ops?: number | null
  }

  export interface PerfMetaRow {
    key: string
    value: string
  }

  export function meta() {
    return (
      (open()?.prepare("SELECT key,value FROM perf_meta ORDER BY key ASC").all() as PerfMetaRow[] | undefined) ?? []
    )
  }

  export interface StoredIssue {
    issue_id: string
    time: number
    iso: string
    severity: PerformanceSchema.IssueSeverity
    status: PerformanceSchema.IssueStatus
    code: string
    title: string
    message: string
    recommendation?: string | null
    module: PerformanceSchema.Module
    trace_id?: string | null
    span_id?: string | null
    session_id?: string | null
    message_id?: string | null
    call_id?: string | null
    rid?: string | null
    evidence_json: string
    first_seen_time: number
    last_seen_time: number
    occurrence_count: number
    fingerprint: string
  }

  const SQL = `
CREATE TABLE IF NOT EXISTS perf_metrics (metric_id TEXT PRIMARY KEY,time INTEGER NOT NULL,iso TEXT NOT NULL,name TEXT NOT NULL,value REAL NOT NULL,unit TEXT NOT NULL,source TEXT NOT NULL,module TEXT NOT NULL,scope_id TEXT,session_id TEXT,message_id TEXT,call_id TEXT,trace_id TEXT,span_id TEXT,parent_span_id TEXT,rid TEXT,process_id TEXT,pid INTEGER,tool TEXT,labels_json TEXT NOT NULL DEFAULT '{}',sample_rate REAL NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS idx_perf_metrics_time ON perf_metrics(time);
CREATE INDEX IF NOT EXISTS idx_perf_metrics_name_time ON perf_metrics(name,time);
CREATE INDEX IF NOT EXISTS idx_perf_metrics_module_time ON perf_metrics(module,time);
CREATE INDEX IF NOT EXISTS idx_perf_metrics_trace_time ON perf_metrics(trace_id,time);
CREATE INDEX IF NOT EXISTS idx_perf_metrics_session_time ON perf_metrics(session_id,time);
CREATE TABLE IF NOT EXISTS perf_spans (trace_id TEXT NOT NULL,span_id TEXT PRIMARY KEY,parent_span_id TEXT,name TEXT NOT NULL,module TEXT NOT NULL,source TEXT NOT NULL,start_time INTEGER NOT NULL,end_time INTEGER,duration_ms REAL,status TEXT NOT NULL DEFAULT 'ok',error_code TEXT,error_message TEXT,scope_id TEXT,session_id TEXT,message_id TEXT,call_id TEXT,rid TEXT,process_id TEXT,pid INTEGER,tool TEXT,attributes_json TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS idx_perf_spans_trace ON perf_spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_perf_spans_start_time ON perf_spans(start_time);
CREATE INDEX IF NOT EXISTS idx_perf_spans_module_start ON perf_spans(module,start_time);
CREATE INDEX IF NOT EXISTS idx_perf_spans_session_start ON perf_spans(session_id,start_time);
CREATE INDEX IF NOT EXISTS idx_perf_spans_rid_start ON perf_spans(rid,start_time);
CREATE TABLE IF NOT EXISTS perf_resource_samples (sample_id TEXT PRIMARY KEY,time INTEGER NOT NULL,iso TEXT NOT NULL,source TEXT NOT NULL,pid INTEGER,process_id TEXT,process_role TEXT NOT NULL DEFAULT 'unknown',cpu_user_micros REAL,cpu_system_micros REAL,cpu_utilization_ratio REAL,memory_rss_bytes INTEGER,memory_heap_total_bytes INTEGER,memory_heap_used_bytes INTEGER,memory_external_bytes INTEGER,memory_array_buffers_bytes INTEGER,event_loop_lag_ms REAL,event_loop_sample_window_ms INTEGER,app_read_bytes INTEGER,app_written_bytes INTEGER,app_read_ops INTEGER,app_write_ops INTEGER,os_read_bytes INTEGER,os_written_bytes INTEGER,os_available INTEGER NOT NULL DEFAULT 0,scope_id TEXT,session_id TEXT,trace_id TEXT,labels_json TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS idx_perf_resource_time ON perf_resource_samples(time);
CREATE INDEX IF NOT EXISTS idx_perf_resource_role_time ON perf_resource_samples(process_role,time);
CREATE INDEX IF NOT EXISTS idx_perf_resource_trace_time ON perf_resource_samples(trace_id,time);
CREATE TABLE IF NOT EXISTS perf_issues (issue_id TEXT PRIMARY KEY,time INTEGER NOT NULL,iso TEXT NOT NULL,severity TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',code TEXT NOT NULL,title TEXT NOT NULL,message TEXT NOT NULL,recommendation TEXT,module TEXT NOT NULL,trace_id TEXT,span_id TEXT,session_id TEXT,message_id TEXT,call_id TEXT,rid TEXT,evidence_json TEXT NOT NULL DEFAULT '{}',first_seen_time INTEGER NOT NULL,last_seen_time INTEGER NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,fingerprint TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_perf_issues_fingerprint_open ON perf_issues(fingerprint) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_perf_issues_time ON perf_issues(time);
CREATE INDEX IF NOT EXISTS idx_perf_issues_status_severity_time ON perf_issues(status,severity,time);
CREATE INDEX IF NOT EXISTS idx_perf_issues_trace_time ON perf_issues(trace_id,time);
CREATE INDEX IF NOT EXISTS idx_perf_issues_module_time ON perf_issues(module,time);
CREATE TABLE IF NOT EXISTS perf_browser_batches (batch_id TEXT PRIMARY KEY,received_time INTEGER NOT NULL,sent_at INTEGER NOT NULL,source TEXT NOT NULL,accepted INTEGER NOT NULL,rejected INTEGER NOT NULL,page_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS perf_aggregates (bucket_start INTEGER NOT NULL,bucket_ms INTEGER NOT NULL,name TEXT NOT NULL,module TEXT,source TEXT,count INTEGER NOT NULL,min_value REAL,max_value REAL,avg_value REAL,p50_value REAL,p95_value REAL,p99_value REAL,sum_value REAL,PRIMARY KEY (bucket_start,bucket_ms,name,module,source));
CREATE INDEX IF NOT EXISTS idx_perf_aggregates_name_bucket ON perf_aggregates(name,bucket_start);
CREATE TABLE IF NOT EXISTS perf_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
`
}
