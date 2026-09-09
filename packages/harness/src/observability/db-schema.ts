import type { Database } from "bun:sqlite"
import { ObservabilityResourceSchema } from "./resource-schema"

export namespace ObservabilityDbSchema {
  export const schemaVersion = 6
  export const SIZE_CAP_TABLES = [
    { table: "obs_metrics", orderBy: "time" },
    { table: "obs_events", orderBy: "time" },
    { table: "obs_resource_samples", orderBy: "time" },
    { table: "obs_browser_batches", orderBy: "received_time" },
    { table: "obs_spans", orderBy: "start_time", where: "status != 'running'" },
    { table: "obs_issues", orderBy: "last_seen_time", where: "status != 'open'" },
  ] as const

  export function configureWriteConnection(conn: Database, fresh: boolean): void {
    if (fresh) conn.exec("PRAGMA auto_vacuum=INCREMENTAL")
    conn.exec("PRAGMA journal_mode=WAL")
    conn.exec("PRAGMA busy_timeout=5000")
    conn.exec("PRAGMA foreign_keys=ON")
    initialize(conn)
    if (fresh) ObservabilityResourceSchema.applyV5(conn)
  }

  function initialize(conn: Database) {
    const now = Date.now()
    conn.exec(SQL)
    conn.query("INSERT OR IGNORE INTO obs_meta (key,value) VALUES ('schemaVersion', ?)").run(String(schemaVersion))
    conn.query("INSERT OR IGNORE INTO obs_meta (key,value) VALUES ('createdAt', ?)").run(new Date(now).toISOString())
    conn.query("INSERT OR IGNORE INTO obs_meta (key,value) VALUES ('lastRetentionRunAt', ?)").run(String(now))
    conn.query("INSERT OR IGNORE INTO obs_meta (key,value) VALUES ('lastWalCheckpointAt', ?)").run(String(now))
  }

  const SQL = `
CREATE TABLE IF NOT EXISTS obs_metrics (metric_id TEXT PRIMARY KEY,time INTEGER NOT NULL,name TEXT NOT NULL,value REAL NOT NULL,unit TEXT NOT NULL,source TEXT NOT NULL,module TEXT NOT NULL,correlation_id TEXT,scope_id TEXT,session_id TEXT,message_id TEXT,call_id TEXT,trace_id TEXT,span_id TEXT,parent_span_id TEXT,rid TEXT,process_id TEXT,pid INTEGER,tool TEXT,labels_json TEXT NOT NULL DEFAULT '{}',sample_rate REAL NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS idx_obs_metrics_time ON obs_metrics(time);
CREATE INDEX IF NOT EXISTS idx_obs_metrics_name_time ON obs_metrics(name,time);
CREATE INDEX IF NOT EXISTS idx_obs_metrics_trace_time ON obs_metrics(trace_id,time);
CREATE INDEX IF NOT EXISTS idx_obs_metrics_session_time ON obs_metrics(session_id,time);
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
