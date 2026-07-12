import fs from "fs/promises"
import { Database } from "bun:sqlite"
import { MigrationRegistry } from "@/migration/registry"
import type { Migration } from "@/migration/types"
import { sha256Content } from "@/util/crypto"
import { ObservabilityRedaction } from "./redaction"
import { ObservabilityStore } from "./store"

export namespace ObservabilityMigration {
  const BATCH_SIZE = 500
  export const schemaVersion = ObservabilityStore.schemaVersion
  export const id = "20260705-observability-store-v2"
  export const redactionBackfillId = "20260711-observability-redaction-backfill"
  export const incrementalVacuumId = "20260711-observability-incremental-vacuum"
  export const schemaMetadataId = "20260712-observability-schema-metadata-v4"

  export async function migrateLegacyPerformance(progress: (current: number, total: number) => void = () => {}) {
    const target = ObservabilityStore.initializeForMigration()
    const legacyPath = ObservabilityStore.legacyPerformancePath()
    const stat = await fs.stat(legacyPath).catch(() => undefined)
    if (!stat?.isFile()) {
      progress(1, 1)
      return
    }
    const legacy = new Database(legacyPath, { readonly: true })
    try {
      const steps = [
        () => copyMetrics(legacy, target),
        () => copySpans(legacy, target),
        () => copyResources(legacy, target),
        () => copyIssues(legacy, target),
        () => copyBrowserBatches(legacy, target),
      ]
      target.transaction(() => {
        steps.forEach((step, index) => {
          step()
          progress(index + 1, steps.length)
        })
        target
          .prepare("INSERT OR REPLACE INTO obs_meta (key,value) VALUES ('legacyPerfMigratedAt', ?)")
          .run(String(Date.now()))
      })()
    } finally {
      legacy.close(false)
    }
  }

  export async function enableIncrementalVacuum(progress: (current: number, total: number) => void = () => {}) {
    ObservabilityStore.enableIncrementalVacuumForMigration()
    progress(1, 1)
  }

  export async function redactCanonicalTelemetry(progress: (current: number, total: number) => void = () => {}) {
    const target = ObservabilityStore.initializeForMigration()
    const steps = [
      () => redactMetrics(target),
      () => redactSpans(target),
      () => redactEvents(target),
      () => redactResources(target),
      () => redactIssues(target),
      () => redactBrowserBatches(target),
    ]
    target.transaction(() => {
      steps.forEach((step, index) => {
        step()
        progress(index + 1, steps.length)
      })
    })()
  }

  export async function synchronizeSchemaMetadata(progress: (current: number, total: number) => void = () => {}) {
    const target = ObservabilityStore.initializeForMigration()
    target.prepare("INSERT OR REPLACE INTO obs_meta (key,value) VALUES ('schemaVersion', ?)").run(String(schemaVersion))
    progress(1, 1)
  }

  function hasTable(db: Database, table: string) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) as
      | { name?: string }
      | undefined
    return !!row?.name
  }

  function tableColumns(db: Database, table: string) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return new Set(rows.map((row) => row.name))
  }

  function legacyMetricTraceSql(db: Database) {
    const columns = tableColumns(db, "perf_metrics")
    if (columns.has("trace_id") && columns.has("traceId")) return "COALESCE(NULLIF(trace_id,''),traceId)"
    if (columns.has("trace_id")) return "trace_id"
    if (columns.has("traceId")) return "traceId"
    return "NULL"
  }

  function legacyMetricNameSql() {
    return `CASE name
      WHEN 'session.active_turns' THEN 'session.turn.active'
      WHEN 'llm.call.duration' THEN 'llm.request.duration'
      WHEN 'llm.stream.start_ms' THEN 'llm.stream.start'
      WHEN 'llm.first_token.ms' THEN 'llm.stream.first_token'
      WHEN 'llm.output.chars' THEN 'llm.stream.output_chars'
      WHEN 'tool.call.count' THEN 'tool.execution.count'
      WHEN 'library.query.duration' THEN 'library.operation.duration'
      WHEN 'process.active' THEN 'process.active.count'
      ELSE name
    END`
  }

  function copyMetrics(legacy: Database, target: Database) {
    if (!hasTable(legacy, "perf_metrics")) return
    const rows = legacy
      .prepare(
        `SELECT metric_id,time,iso,${legacyMetricNameSql()} AS name,value,unit,source,module,scope_id,session_id,message_id,call_id,${legacyMetricTraceSql(legacy)} AS trace_id,span_id,parent_span_id,rid,process_id,pid,tool,labels_json,sample_rate FROM perf_metrics`,
      )
      .iterate() as IterableIterator<LegacyMetricRow>
    const insert = target.prepare(
      `INSERT OR IGNORE INTO obs_metrics (metric_id,time,iso,name,value,unit,source,module,scope_id,session_id,message_id,call_id,trace_id,span_id,parent_span_id,rid,process_id,pid,tool,labels_json,sample_rate,redaction_json)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)`,
    )
    for (const row of rows) {
      const labels = ObservabilityRedaction.redactRecord(parseJsonRecord(row.labels_json))
      insert.run(
        row.metric_id,
        row.time,
        row.iso,
        row.name,
        row.value,
        row.unit,
        row.source,
        row.module,
        row.scope_id ?? null,
        row.session_id ?? null,
        row.message_id ?? null,
        row.call_id ?? null,
        row.trace_id ?? null,
        row.span_id ?? null,
        row.parent_span_id ?? null,
        row.rid ?? null,
        row.process_id ?? null,
        row.pid ?? null,
        row.tool ?? null,
        JSON.stringify(labels.value),
        row.sample_rate,
        JSON.stringify(labels.summary),
      )
    }
  }

  function copySpans(legacy: Database, target: Database) {
    if (!hasTable(legacy, "perf_spans")) return
    const rows = legacy
      .prepare(
        `SELECT trace_id,span_id,parent_span_id,name,module,source,start_time,end_time,duration_ms,status,error_code,error_message,scope_id,session_id,message_id,call_id,rid,process_id,pid,tool FROM perf_spans`,
      )
      .iterate() as IterableIterator<LegacySpanRow>
    const insert = target.prepare(
      `INSERT OR IGNORE INTO obs_spans (trace_id,span_id,parent_span_id,kind,name,module,source,start_time,end_time,duration_ms,last_activity_time,heartbeat_count,stalled,status,error_code,error_message,scope_id,session_id,message_id,call_id,rid,process_id,pid,tool,attributes_json,redaction_json)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0,0,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,'{}',?23)`,
    )
    for (const row of rows) {
      const name = ObservabilityRedaction.text(row.name)
      const errorMessage = row.error_message ? ObservabilityRedaction.text(row.error_message) : null
      insert.run(
        row.trace_id,
        row.span_id,
        row.parent_span_id ?? null,
        legacySpanKind(row.name),
        name,
        row.module,
        row.source,
        row.start_time,
        row.end_time ?? null,
        row.duration_ms ?? null,
        row.end_time ?? row.start_time,
        row.status,
        row.error_code ?? null,
        errorMessage,
        row.scope_id ?? null,
        row.session_id ?? null,
        row.message_id ?? null,
        row.call_id ?? null,
        row.rid ?? null,
        row.process_id ?? null,
        row.pid ?? null,
        row.tool ?? null,
        JSON.stringify({
          applied: true,
          omittedKeys: 0,
          truncatedValues: name !== row.name || errorMessage !== row.error_message ? 1 : 0,
        }),
      )
    }
  }

  function copyResources(legacy: Database, target: Database) {
    if (!hasTable(legacy, "perf_resource_samples")) return
    const rows = legacy.prepare("SELECT * FROM perf_resource_samples").iterate() as IterableIterator<LegacyResourceRow>
    const insert = target.prepare(
      `INSERT OR IGNORE INTO obs_resource_samples (sample_id,time,iso,source,correlation_id,trace_id,scope_id,session_id,pid,process_id,process_role,cpu_user_micros,cpu_system_micros,cpu_utilization_ratio,memory_rss_bytes,memory_heap_total_bytes,memory_heap_used_bytes,memory_external_bytes,memory_array_buffers_bytes,event_loop_lag_ms,event_loop_sample_window_ms,app_read_bytes,app_written_bytes,app_read_ops,app_write_ops,os_read_bytes,os_written_bytes,os_available,labels_json,redaction_json)
       VALUES (?1,?2,?3,?4,NULL,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29)`,
    )
    for (const row of rows) {
      const labels = ObservabilityRedaction.redactRecord(parseJsonRecord(row.labels_json))
      insert.run(
        row.sample_id,
        row.time,
        row.iso,
        row.source,
        row.trace_id ?? null,
        row.scope_id ?? null,
        row.session_id ?? null,
        row.pid ?? null,
        row.process_id ?? null,
        row.process_role ?? "unknown",
        row.cpu_user_micros ?? null,
        row.cpu_system_micros ?? null,
        row.cpu_utilization_ratio ?? null,
        row.memory_rss_bytes ?? null,
        row.memory_heap_total_bytes ?? null,
        row.memory_heap_used_bytes ?? null,
        row.memory_external_bytes ?? null,
        row.memory_array_buffers_bytes ?? null,
        row.event_loop_lag_ms ?? null,
        row.event_loop_sample_window_ms ?? 0,
        row.app_read_bytes ?? null,
        row.app_written_bytes ?? null,
        row.app_read_ops ?? null,
        row.app_write_ops ?? null,
        row.os_read_bytes ?? null,
        row.os_written_bytes ?? null,
        row.os_available ?? 0,
        JSON.stringify(labels.value),
        JSON.stringify(labels.summary),
      )
    }
  }

  function copyIssues(legacy: Database, target: Database) {
    if (!hasTable(legacy, "perf_issues")) return
    const rows = legacy
      .prepare(
        `SELECT issue_id,time,iso,severity,status,code,title,message,recommendation,module,trace_id,span_id,session_id,message_id,call_id,rid,evidence_json,first_seen_time,last_seen_time,occurrence_count,fingerprint FROM perf_issues`,
      )
      .iterate() as IterableIterator<LegacyIssueRow>
    const insert = target.prepare(
      `INSERT OR IGNORE INTO obs_issues (issue_id,time,iso,severity,status,code,title,message,recommendation,module,trace_id,span_id,session_id,message_id,call_id,rid,evidence_json,first_seen_time,last_seen_time,occurrence_count,fingerprint,redaction_json)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)`,
    )
    for (const row of rows) {
      const title = ObservabilityRedaction.text(row.title)
      const message = ObservabilityRedaction.text(row.message)
      const recommendation = row.recommendation ? ObservabilityRedaction.text(row.recommendation) : null
      const evidence = ObservabilityRedaction.redactRecord(parseJsonRecord(row.evidence_json))
      const changed = title !== row.title || message !== row.message || recommendation !== row.recommendation
      insert.run(
        row.issue_id,
        row.time,
        row.iso,
        row.severity,
        row.status,
        row.code,
        title,
        message,
        recommendation,
        row.module,
        row.trace_id ?? null,
        row.span_id ?? null,
        row.session_id ?? null,
        row.message_id ?? null,
        row.call_id ?? null,
        row.rid ?? null,
        JSON.stringify(evidence.value),
        row.first_seen_time,
        row.last_seen_time,
        row.occurrence_count,
        legacyFingerprint(row.fingerprint),
        JSON.stringify({
          applied: true,
          omittedKeys: evidence.summary.omittedKeys,
          truncatedValues: evidence.summary.truncatedValues + (changed ? 1 : 0),
        }),
      )
    }
  }

  function copyBrowserBatches(legacy: Database, target: Database) {
    if (!hasTable(legacy, "perf_browser_batches")) return
    const rows = legacy
      .prepare("SELECT * FROM perf_browser_batches")
      .iterate() as IterableIterator<LegacyBrowserBatchRow>
    const insert = target.prepare(
      `INSERT OR IGNORE INTO obs_browser_batches (batch_id,received_time,sent_at,source,accepted,rejected,page_json)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`,
    )
    for (const row of rows) {
      const page = ObservabilityRedaction.value(parseJsonRecord(row.page_json))
      insert.run(
        row.batch_id,
        row.received_time,
        row.sent_at,
        row.source,
        row.accepted,
        row.rejected,
        JSON.stringify(page.value),
      )
    }
  }

  function parseJsonRecord(value: string | null | undefined) {
    try {
      const parsed = JSON.parse(value || "{}")
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
      return parsed as Record<string, unknown>
    } catch {
      return {}
    }
  }

  function forEachBatch<Row extends { migration_id: string }>(
    target: Database,
    sql: string,
    visit: (row: Row) => void,
  ) {
    const select = target.prepare(sql)
    let after: string | null = null
    while (true) {
      const rows = select.all(after, BATCH_SIZE) as Row[]
      if (rows.length === 0) return
      for (const row of rows) visit(row)
      after = rows[rows.length - 1].migration_id
    }
  }

  function redactMetrics(target: Database) {
    const update = target.prepare("UPDATE obs_metrics SET labels_json = ?, redaction_json = ? WHERE metric_id = ?")
    forEachBatch<{ migration_id: string; labels_json?: string | null }>(
      target,
      "SELECT metric_id AS migration_id,labels_json FROM obs_metrics WHERE (?1 IS NULL OR metric_id > ?1) ORDER BY metric_id LIMIT ?2",
      (row) => {
        const labels = ObservabilityRedaction.redactRecord(parseJsonRecord(row.labels_json))
        update.run(JSON.stringify(labels.value), JSON.stringify(labels.summary), row.migration_id)
      },
    )
  }

  function redactSpans(target: Database) {
    const update = target.prepare(
      "UPDATE obs_spans SET name = ?, error_message = ?, attributes_json = ?, redaction_json = ? WHERE span_id = ?",
    )
    forEachBatch<{
      migration_id: string
      name: string
      error_message?: string | null
      attributes_json?: string | null
    }>(
      target,
      "SELECT span_id AS migration_id,name,error_message,attributes_json FROM obs_spans WHERE (?1 IS NULL OR span_id > ?1) ORDER BY span_id LIMIT ?2",
      (row) => {
        const name = ObservabilityRedaction.text(row.name)
        const errorMessage = row.error_message ? ObservabilityRedaction.text(row.error_message) : null
        const attributes = ObservabilityRedaction.redactRecord(parseJsonRecord(row.attributes_json))
        update.run(
          name,
          errorMessage,
          JSON.stringify(attributes.value),
          JSON.stringify(withTextChanges(attributes.summary, name !== row.name || errorMessage !== row.error_message)),
          row.migration_id,
        )
      },
    )
  }

  function redactEvents(target: Database) {
    const update = target.prepare("UPDATE obs_events SET cwd = ?, data_json = ?, redaction_json = ? WHERE event_id = ?")
    forEachBatch<{ migration_id: string; cwd?: string | null; data_json?: string | null }>(
      target,
      "SELECT event_id AS migration_id,cwd,data_json FROM obs_events WHERE (?1 IS NULL OR event_id > ?1) ORDER BY event_id LIMIT ?2",
      (row) => {
        const data = ObservabilityRedaction.redactRecord(parseJsonRecord(row.data_json))
        update.run(
          row.cwd ? ObservabilityRedaction.cwdScope(row.cwd) : null,
          JSON.stringify(data.value),
          JSON.stringify(data.summary),
          row.migration_id,
        )
      },
    )
  }

  function redactResources(target: Database) {
    const update = target.prepare(
      "UPDATE obs_resource_samples SET labels_json = ?, redaction_json = ? WHERE sample_id = ?",
    )
    forEachBatch<{ migration_id: string; labels_json?: string | null }>(
      target,
      "SELECT sample_id AS migration_id,labels_json FROM obs_resource_samples WHERE (?1 IS NULL OR sample_id > ?1) ORDER BY sample_id LIMIT ?2",
      (row) => {
        const labels = ObservabilityRedaction.redactRecord(parseJsonRecord(row.labels_json))
        update.run(JSON.stringify(labels.value), JSON.stringify(labels.summary), row.migration_id)
      },
    )
  }

  function redactIssues(target: Database) {
    const update = target.prepare(
      "UPDATE obs_issues SET title = ?, message = ?, recommendation = ?, evidence_json = ?, redaction_json = ? WHERE issue_id = ?",
    )
    forEachBatch<{
      migration_id: string
      title: string
      message: string
      recommendation?: string | null
      evidence_json?: string | null
    }>(
      target,
      "SELECT issue_id AS migration_id,title,message,recommendation,evidence_json FROM obs_issues WHERE (?1 IS NULL OR issue_id > ?1) ORDER BY issue_id LIMIT ?2",
      (row) => {
        const title = ObservabilityRedaction.text(row.title)
        const message = ObservabilityRedaction.text(row.message)
        const recommendation = row.recommendation ? ObservabilityRedaction.text(row.recommendation) : null
        const evidence = ObservabilityRedaction.redactRecord(parseJsonRecord(row.evidence_json))
        const changed = title !== row.title || message !== row.message || recommendation !== row.recommendation
        update.run(
          title,
          message,
          recommendation,
          JSON.stringify(evidence.value),
          JSON.stringify(withTextChanges(evidence.summary, changed)),
          row.migration_id,
        )
      },
    )
  }

  function redactBrowserBatches(target: Database) {
    const update = target.prepare("UPDATE obs_browser_batches SET page_json = ? WHERE batch_id = ?")
    forEachBatch<{ migration_id: string; page_json?: string | null }>(
      target,
      "SELECT batch_id AS migration_id,page_json FROM obs_browser_batches WHERE (?1 IS NULL OR batch_id > ?1) ORDER BY batch_id LIMIT ?2",
      (row) => {
        const page = ObservabilityRedaction.value(parseJsonRecord(row.page_json))
        update.run(JSON.stringify(page.value), row.migration_id)
      },
    )
  }

  function withTextChanges(
    summary: { applied: boolean; omittedKeys: number; truncatedValues: number },
    changed: boolean,
  ) {
    return { ...summary, truncatedValues: summary.truncatedValues + (changed ? 1 : 0) }
  }

  interface LegacyMetricRow {
    metric_id: string
    time: number
    iso: string
    name: string
    value: number
    unit: string
    source: string
    module: string
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
    labels_json?: string | null
    sample_rate: number
  }

  interface LegacyResourceRow {
    sample_id: string
    time: number
    iso: string
    source: string
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
  }

  interface LegacyBrowserBatchRow {
    batch_id: string
    received_time: number
    sent_at: number
    source: string
    accepted: number
    rejected: number
    page_json?: string | null
  }

  interface LegacySpanRow {
    trace_id: string
    span_id: string
    parent_span_id?: string | null
    name: string
    module: string
    source: string
    start_time: number
    end_time?: number | null
    duration_ms?: number | null
    status: string
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
  }

  interface LegacyIssueRow {
    issue_id: string
    time: number
    iso: string
    severity: string
    status: string
    code: string
    title: string
    message: string
    recommendation?: string | null
    module: string
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

  function legacySpanKind(name: string) {
    if (name.includes("http")) return "http"
    if (name.includes("session.step")) return "session_step"
    if (name.includes("session")) return "session"
    if (name.includes("tool")) return "tool"
    if (name.includes("llm")) return "llm"
    if (name.includes("storage")) return "storage"
    if (name.includes("library")) return "library"
    if (name.includes("sse")) return "sse"
    if (name.includes("mcp")) return "mcp"
    if (name.includes("plugin")) return "plugin"
    if (name.includes("channel")) return "channel"
    if (name.includes("permission") || name.includes("enforcement")) return "permission"
    if (name.includes("diagnostic")) return "diagnostic"
    if (name.includes("process")) return "process"
    if (name.includes("frontend")) return "frontend"
    return "runtime"
  }

  function legacyFingerprint(input: string) {
    return `legacy:${sha256Content(input).slice(0, 32)}`
  }
}

const migrations: Migration[] = [
  {
    id: ObservabilityMigration.id,
    description: "Create indexed observability store and migrate legacy perf telemetry",
    domain: "observability",
    version: String(ObservabilityMigration.schemaVersion),
    async up(progress) {
      await ObservabilityMigration.migrateLegacyPerformance(progress)
    },
  },
  {
    id: ObservabilityMigration.redactionBackfillId,
    description: "Redact existing canonical observability telemetry",
    domain: "observability",
    version: String(ObservabilityMigration.schemaVersion),
    dependsOn: [ObservabilityMigration.id],
    async up(progress) {
      await ObservabilityMigration.redactCanonicalTelemetry(progress)
    },
  },
  {
    id: ObservabilityMigration.incrementalVacuumId,
    description: "Enable incremental vacuum for bounded observability storage",
    domain: "observability",
    version: String(ObservabilityMigration.schemaVersion),
    dependsOn: [ObservabilityMigration.redactionBackfillId],
    async up(progress) {
      await ObservabilityMigration.enableIncrementalVacuum(progress)
    },
  },
  {
    id: ObservabilityMigration.schemaMetadataId,
    description: "Synchronize observability schema metadata",
    domain: "observability",
    version: String(ObservabilityMigration.schemaVersion),
    dependsOn: [ObservabilityMigration.incrementalVacuumId],
    async up(progress) {
      await ObservabilityMigration.synchronizeSchemaMetadata(progress)
    },
  },
]

MigrationRegistry.register("observability", migrations)
