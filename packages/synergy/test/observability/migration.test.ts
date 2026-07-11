import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "fs"
import { Database } from "bun:sqlite"
import { ObservabilityMigration } from "../../src/observability/migration"
import { ObservabilityStore } from "../../src/observability/store"
import { PerformanceDashboard } from "../../src/performance/dashboard"
import { ObservabilityConfig } from "../../src/observability/config"
import { cleanupObservabilityHomes, resetObservabilityHome } from "./fixture"

describe("ObservabilityMigration", () => {
  beforeEach(() => resetObservabilityHome())
  afterEach(() => cleanupObservabilityHomes())

  test("migrates legacy perf tables into obs tables idempotently", async () => {
    seedLegacyPerformanceStore()

    await ObservabilityMigration.migrateLegacyPerformance()
    ObservabilityStore.flush()
    await ObservabilityMigration.migrateLegacyPerformance()
    ObservabilityStore.flush()

    const metrics = ObservabilityStore.queryMetrics({ since: 0, names: ["http.request.duration"] })
    expect(metrics).toHaveLength(1)
    expect(metrics[0].metric_id).toBe("legacy_metric_1")

    const spans = ObservabilityStore.querySpans({ traceId: "trace_legacy" })
    expect(spans).toHaveLength(1)
    expect(spans[0].span_id).toBe("legacy_span_1")
    expect(spans[0].kind).toBe("http")

    expect(ObservabilityStore.resourceSince(0).map((row) => row.sample_id)).toEqual(["legacy_resource_1"])
    const issues = ObservabilityStore.queryIssues({ status: "open" })
    expect(issues.map((row) => row.issue_id)).toEqual(["legacy_issue_1"])
    expect(issues[0].fingerprint).toStartWith("legacy:")
    const evidence = JSON.parse(issues[0].evidence_json)
    expect(evidence.stack).toBe("Error: test\n  at file.ts:1")
    expect(evidence.scopeID).toBe("sc_legacy")
    const migratedJson = JSON.stringify({ spans, issues })
    expect(migratedJson).not.toContain("sk-legacy-secret")
    expect(migratedJson).not.toContain("ghp_legacysecret")
    expect(ObservabilityStore.meta().some((row) => row.key === "legacyPerfMigratedAt")).toBe(true)

    const summary = await PerformanceDashboard.summary({ windowMs: 60_000 })
    expect(summary.backend.requestCount).toBe(1)
  })

  test("migrates legacy perf tables even when runtime observability is disabled", async () => {
    seedLegacyPerformanceStore()
    ObservabilityConfig.refresh({
      observability: { enabled: false, performance: { storage: { sqliteEnabled: false } } },
    })

    await ObservabilityMigration.migrateLegacyPerformance()
    ObservabilityConfig.refresh()

    const metrics = ObservabilityStore.queryMetrics({ since: 0, names: ["http.request.duration"] })
    expect(metrics).toHaveLength(1)
    expect(metrics[0].metric_id).toBe("legacy_metric_1")
  })
})

function seedLegacyPerformanceStore() {
  const legacyPath = ObservabilityStore.legacyPerformancePath()
  mkdirSync(legacyPath.slice(0, legacyPath.lastIndexOf("/")), { recursive: true })
  const db = new Database(legacyPath, { create: true })
  const now = Date.now()
  try {
    db.exec(`
      CREATE TABLE perf_metrics (metric_id TEXT PRIMARY KEY,time INTEGER NOT NULL,iso TEXT NOT NULL,name TEXT NOT NULL,value REAL NOT NULL,unit TEXT NOT NULL,source TEXT NOT NULL,module TEXT NOT NULL,scope_id TEXT,session_id TEXT,message_id TEXT,call_id TEXT,traceId TEXT,trace_id TEXT,span_id TEXT,parent_span_id TEXT,rid TEXT,process_id TEXT,pid INTEGER,tool TEXT,labels_json TEXT NOT NULL DEFAULT '{}',sample_rate REAL NOT NULL DEFAULT 1);
      CREATE TABLE perf_spans (trace_id TEXT NOT NULL,span_id TEXT PRIMARY KEY,parent_span_id TEXT,name TEXT NOT NULL,module TEXT NOT NULL,source TEXT NOT NULL,start_time INTEGER NOT NULL,end_time INTEGER,duration_ms REAL,status TEXT NOT NULL,error_code TEXT,error_message TEXT,scope_id TEXT,session_id TEXT,message_id TEXT,call_id TEXT,rid TEXT,process_id TEXT,pid INTEGER,tool TEXT,attributes_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE perf_resource_samples (sample_id TEXT PRIMARY KEY,time INTEGER NOT NULL,iso TEXT NOT NULL,source TEXT NOT NULL,trace_id TEXT,scope_id TEXT,session_id TEXT,pid INTEGER,process_id TEXT,process_role TEXT NOT NULL DEFAULT 'unknown',cpu_user_micros REAL,cpu_system_micros REAL,cpu_utilization_ratio REAL,memory_rss_bytes INTEGER,memory_heap_total_bytes INTEGER,memory_heap_used_bytes INTEGER,memory_external_bytes INTEGER,memory_array_buffers_bytes INTEGER,event_loop_lag_ms REAL,event_loop_sample_window_ms REAL,app_read_bytes INTEGER,app_written_bytes INTEGER,app_read_ops INTEGER,app_write_ops INTEGER,os_read_bytes INTEGER,os_written_bytes INTEGER,os_available INTEGER,labels_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE perf_issues (issue_id TEXT PRIMARY KEY,time INTEGER NOT NULL,iso TEXT NOT NULL,severity TEXT NOT NULL,status TEXT NOT NULL,code TEXT NOT NULL,title TEXT NOT NULL,message TEXT NOT NULL,recommendation TEXT,module TEXT NOT NULL,trace_id TEXT,span_id TEXT,session_id TEXT,message_id TEXT,call_id TEXT,rid TEXT,evidence_json TEXT NOT NULL DEFAULT '{}',first_seen_time INTEGER NOT NULL,last_seen_time INTEGER NOT NULL,occurrence_count INTEGER NOT NULL,fingerprint TEXT NOT NULL);
      CREATE TABLE perf_browser_batches (batch_id TEXT PRIMARY KEY,received_time INTEGER NOT NULL,sent_at INTEGER NOT NULL,source TEXT NOT NULL,accepted INTEGER NOT NULL,rejected INTEGER NOT NULL,page_json TEXT NOT NULL DEFAULT '{}');
    `)
    db.prepare(
      `INSERT INTO perf_metrics (metric_id,time,iso,name,value,unit,source,module,trace_id,labels_json,sample_rate)
       VALUES ('legacy_metric_1',?1,?2,'http.request.duration',42,'ms','backend','server','trace_legacy','{"path":"/legacy"}',1)`,
    ).run(now, new Date(now).toISOString())
    db.prepare(
      `INSERT INTO perf_spans (trace_id,span_id,name,module,source,start_time,end_time,duration_ms,status,error_code,error_message,attributes_json)
       VALUES ('trace_legacy','legacy_span_1','http.request','server','backend',?1,?2,42,'ok','LEGACY_FAILURE','legacy failed with sk-legacy-secret','{}')`,
    ).run(now - 42, now)
    db.prepare(
      `INSERT INTO perf_resource_samples (sample_id,time,iso,source,trace_id,process_role,cpu_utilization_ratio,memory_rss_bytes,event_loop_sample_window_ms,labels_json)
       VALUES ('legacy_resource_1',?1,?2,'process','trace_legacy','server',0.1,1024,5000,'{}')`,
    ).run(now, new Date(now).toISOString())
    db.prepare(
      `INSERT INTO perf_issues (issue_id,time,iso,severity,status,code,title,message,recommendation,module,trace_id,evidence_json,first_seen_time,last_seen_time,occurrence_count,fingerprint)
       VALUES ('legacy_issue_1',?1,?2,'warning','open','PERF_LEGACY','Legacy issue sk-legacy-secret','Legacy issue ghp_legacysecret','Inspect tok_legacy_secret','server','trace_legacy','{"stack":"Error: test\\n  at file.ts:1","scopeID":"sc_legacy"}',?1,?1,1,'sk-legacy-secret')`,
    ).run(now, new Date(now).toISOString())
    db.prepare(
      `INSERT INTO perf_browser_batches (batch_id,received_time,sent_at,source,accepted,rejected,page_json)
       VALUES ('legacy_batch_1',?1,?1,'browser',1,0,'{}')`,
    ).run(now)
  } finally {
    db.close(false)
  }
}
