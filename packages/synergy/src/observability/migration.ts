import fs from "fs/promises"
import { Database } from "bun:sqlite"
import { MigrationRegistry } from "@/migration/registry"
import type { Migration } from "@/migration/types"
import { sha256Content } from "@/util/crypto"
import { ObservabilityRedaction } from "./redaction"
import { ObservabilityStore } from "./store"

export namespace ObservabilityMigration {
  export const schemaVersion = 2
  export const id = "20260705-observability-store-v2"

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

  function hasTable(db: Database, table: string) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) as
      | { name?: string }
      | undefined
    return !!row?.name
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
    attachLegacy(target)
    target
      .prepare(
        `INSERT OR IGNORE INTO obs_metrics (metric_id,time,iso,name,value,unit,source,module,scope_id,session_id,message_id,call_id,trace_id,span_id,parent_span_id,rid,process_id,pid,tool,labels_json,sample_rate,redaction_json)
         SELECT metric_id,time,iso,${legacyMetricNameSql()},value,unit,source,module,scope_id,session_id,message_id,call_id,COALESCE(NULLIF(trace_id,''),traceId),span_id,parent_span_id,rid,process_id,pid,tool,COALESCE(labels_json,'{}'),sample_rate,'{"applied":false,"omittedKeys":0,"truncatedValues":0}' FROM legacy.perf_metrics`,
      )
      .run()
  }

  function copySpans(legacy: Database, target: Database) {
    if (!hasTable(legacy, "perf_spans")) return
    const rows = legacy
      .prepare(
        `SELECT trace_id,span_id,parent_span_id,name,module,source,start_time,end_time,duration_ms,status,error_code,error_message,scope_id,session_id,message_id,call_id,rid,process_id,pid,tool FROM perf_spans`,
      )
      .all() as LegacySpanRow[]
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
    attachLegacy(target)
    target
      .prepare(
        `INSERT OR IGNORE INTO obs_resource_samples (
          sample_id,time,iso,source,correlation_id,trace_id,scope_id,session_id,pid,process_id,process_role,
          cpu_user_micros,cpu_system_micros,cpu_utilization_ratio,
          memory_rss_bytes,memory_heap_total_bytes,memory_heap_used_bytes,memory_external_bytes,memory_array_buffers_bytes,
          event_loop_lag_ms,event_loop_sample_window_ms,
          app_read_bytes,app_written_bytes,app_read_ops,app_write_ops,os_read_bytes,os_written_bytes,os_available,
          labels_json,redaction_json
        )
         SELECT sample_id,time,iso,source,NULL,trace_id,scope_id,session_id,pid,process_id,COALESCE(process_role,'unknown'),
          cpu_user_micros,cpu_system_micros,cpu_utilization_ratio,
          memory_rss_bytes,memory_heap_total_bytes,memory_heap_used_bytes,memory_external_bytes,memory_array_buffers_bytes,
          event_loop_lag_ms,COALESCE(event_loop_sample_window_ms,0),
          app_read_bytes,app_written_bytes,app_read_ops,app_write_ops,os_read_bytes,os_written_bytes,COALESCE(os_available,0),
          '{}','{"applied":false,"omittedKeys":0,"truncatedValues":0}'
         FROM legacy.perf_resource_samples`,
      )
      .run()
  }

  function copyIssues(legacy: Database, target: Database) {
    if (!hasTable(legacy, "perf_issues")) return
    const rows = legacy
      .prepare(
        `SELECT issue_id,time,iso,severity,status,code,title,message,recommendation,module,trace_id,span_id,session_id,message_id,call_id,rid,evidence_json,first_seen_time,last_seen_time,occurrence_count,fingerprint FROM perf_issues`,
      )
      .all() as LegacyIssueRow[]
    const insert = target.prepare(
      `INSERT OR IGNORE INTO obs_issues (issue_id,time,iso,severity,status,code,title,message,recommendation,module,trace_id,span_id,session_id,message_id,call_id,rid,evidence_json,first_seen_time,last_seen_time,occurrence_count,fingerprint,redaction_json)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)`,
    )
    for (const row of rows) {
      const title = ObservabilityRedaction.text(row.title)
      const message = ObservabilityRedaction.text(row.message)
      const recommendation = row.recommendation ? ObservabilityRedaction.text(row.recommendation) : null
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
        row.evidence_json,
        row.first_seen_time,
        row.last_seen_time,
        row.occurrence_count,
        legacyFingerprint(row.fingerprint),
        JSON.stringify({ applied: true, omittedKeys: 0, truncatedValues: changed ? 1 : 0 }),
      )
    }
  }

  function copyBrowserBatches(legacy: Database, target: Database) {
    if (!hasTable(legacy, "perf_browser_batches")) return
    attachLegacy(target)
    target
      .prepare(
        `INSERT OR IGNORE INTO obs_browser_batches (batch_id,received_time,sent_at,source,accepted,rejected,page_json)
         SELECT batch_id,received_time,sent_at,source,accepted,rejected,COALESCE(page_json,'{}') FROM legacy.perf_browser_batches`,
      )
      .run()
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

  function attachLegacy(target: Database) {
    const attached = target.prepare("PRAGMA database_list").all() as Array<{ name?: string }>
    if (attached.some((row) => row.name === "legacy")) return
    target.prepare("ATTACH DATABASE ? AS legacy").run(ObservabilityStore.legacyPerformancePath())
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
]

MigrationRegistry.register("observability", migrations)
