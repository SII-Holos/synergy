import type { Database } from "bun:sqlite"
import { ObservabilitySchema } from "./schema"

export namespace ObservabilityDbWrites {
  export function insertMetric(conn: Database, metric: ObservabilitySchema.Metric) {
    conn
      .query(
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

  export function upsertSpan(conn: Database, span: ObservabilitySchema.Span) {
    conn
      .query(
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

  export function insertEvent(conn: Database, event: ObservabilitySchema.Event) {
    conn
      .query(
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

  export function insertResource(conn: Database, sample: ObservabilitySchema.ResourceSample) {
    conn
      .query(
        `INSERT OR REPLACE INTO obs_resource_samples (sample_id,time,iso,source,correlation_id,trace_id,scope_id,session_id,pid,process_id,process_role,cpu_user_micros,cpu_system_micros,cpu_utilization_ratio,memory_rss_bytes,memory_heap_total_bytes,memory_heap_used_bytes,memory_external_bytes,memory_array_buffers_bytes,event_loop_lag_ms,event_loop_sample_window_ms,app_read_bytes,app_written_bytes,app_read_ops,app_write_ops,os_read_bytes,os_written_bytes,os_available,cgroup_current_bytes,cgroup_high_bytes,cgroup_max_bytes,cgroup_peak_bytes,cgroup_oom_count,cgroup_oom_kill_count,service_memory_rss_bytes,service_memory_source,service_memory_completeness,labels_json,redaction_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37,?38,?39)`,
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
        sample.cgroup?.currentBytes ?? null,
        sample.cgroup?.highBytes ?? null,
        sample.cgroup?.maxBytes ?? null,
        sample.cgroup?.peakBytes ?? null,
        sample.cgroup?.oomCount ?? null,
        sample.cgroup?.oomKillCount ?? null,
        sample.serviceMemory?.rssBytes ?? null,
        sample.serviceMemory?.source ?? null,
        sample.serviceMemory?.completeness ?? null,
        JSON.stringify(sample.labels ?? {}),
        JSON.stringify(sample.redaction),
      )
  }

  export function insertIssue(conn: Database, issue: ObservabilitySchema.Issue) {
    conn
      .query(
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

  export function insertBrowserBatch(
    conn: Database,
    input: {
      batchId: string
      receivedTime: number
      sentAt: number
      accepted: number
      rejected: number
      page: Record<string, unknown>
    },
  ) {
    conn
      .query(
        `INSERT OR REPLACE INTO obs_browser_batches (batch_id,received_time,sent_at,source,accepted,rejected,page_json) VALUES (?1,?2,?3,'browser',?4,?5,?6)`,
      )
      .run(input.batchId, input.receivedTime, input.sentAt, input.accepted, input.rejected, JSON.stringify(input.page))
  }

  export function interruptRunningSpans(conn: Database, reason: "previous_runtime_ended" | "runtime_shutdown"): number {
    return conn
      .query(
        `UPDATE obs_spans
         SET end_time = COALESCE(last_activity_time, start_time),
             duration_ms = MAX(0, COALESCE(last_activity_time, start_time) - start_time),
             last_activity_time = COALESCE(last_activity_time, start_time),
             status = 'interrupted',
             error_code = 'PROCESS_INTERRUPTED',
             error_message = ?
         WHERE status = 'running'`,
      )
      .run(reason).changes
  }

  export function retain(conn: Database, now: number, metricCutoff: number, traceCutoff: number) {
    conn.query("DELETE FROM obs_metrics WHERE time < ?").run(metricCutoff)
    conn.query("DELETE FROM obs_events WHERE time < ?").run(traceCutoff)
    conn.query("DELETE FROM obs_resource_samples WHERE time < ?").run(metricCutoff)
    conn.query("DELETE FROM obs_spans WHERE start_time < ? AND status != 'running'").run(traceCutoff)
    conn.query("DELETE FROM obs_browser_batches WHERE received_time < ?").run(metricCutoff)
    conn.query("DELETE FROM obs_issues WHERE status != 'open' AND time < ?").run(traceCutoff)
    conn.query("INSERT OR REPLACE INTO obs_meta (key,value) VALUES ('lastRetentionRunAt', ?)").run(String(now))
  }

  export function checkpoint(conn: Database) {
    conn.query("INSERT OR REPLACE INTO obs_meta (key,value) VALUES ('lastWalCheckpointAt', ?)").run(String(Date.now()))
    conn.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  }
}
