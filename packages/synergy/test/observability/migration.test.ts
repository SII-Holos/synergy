import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "fs"
import { Database } from "bun:sqlite"
import { getMigrationStatus, runMigrations } from "../../src/migration"
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
    expect(evidence.stack).toBe("[redacted]")
    expect(evidence.scopeID).toBe("sc_legacy")
    const resources = ObservabilityStore.resourceSince(0)
    const migratedJson = JSON.stringify({ metrics, spans, issues, resources })
    expect(migratedJson).not.toContain("sk-legacy-secret")
    expect(migratedJson).not.toContain("ghp_legacysecret")
    expect(migratedJson).not.toContain("Bearer legacy-authorization-secret")
    expect(ObservabilityStore.meta().some((row) => row.key === "legacyPerfMigratedAt")).toBe(true)

    const summary = await PerformanceDashboard.summary({ windowMs: 60_000 })
    expect(summary.backend.requestCount).toBe(1)
  })

  test("migrates the camel-case traceId metric schema", async () => {
    seedLegacyPerformanceStore("camel")

    await ObservabilityMigration.migrateLegacyPerformance()

    const metrics = ObservabilityStore.queryMetrics({ since: 0, traceId: "trace_legacy" })
    expect(metrics.map((row) => row.metric_id)).toEqual(["legacy_metric_1"])
  })

  test("prefers the canonical trace_id when both legacy metric columns exist", async () => {
    seedLegacyPerformanceStore("both")

    await ObservabilityMigration.migrateLegacyPerformance()

    expect(ObservabilityStore.queryMetrics({ since: 0, traceId: "trace_legacy" })).toHaveLength(1)
    expect(ObservabilityStore.queryMetrics({ since: 0, traceId: "trace_camel_fallback" })).toHaveLength(0)
  })

  test("records a released-schema upgrade through the central migration runner", async () => {
    seedLegacyPerformanceStore()

    const summary = await runMigrations({ output: "silent", targetDomain: "observability" })
    const status = await getMigrationStatus("observability")

    expect(summary.completed).toBe(5)
    expect(status.observability.pending).toHaveLength(0)
    expect(status.observability.completed.map((migration) => migration.id)).toContain(ObservabilityMigration.id)
  })

  test("rolls back the canonical copy when a legacy table is malformed", async () => {
    seedLegacyPerformanceStore()
    const legacy = new Database(ObservabilityStore.legacyPerformancePath())
    legacy.exec("ALTER TABLE perf_spans DROP COLUMN source")
    legacy.close(true)

    await expect(ObservabilityMigration.migrateLegacyPerformance()).rejects.toThrow("source")

    const target = ObservabilityStore.initializeForMigration()
    const row = getRow<{ count: number }>(target, "SELECT COUNT(*) AS count FROM obs_metrics")
    expect(row.count).toBe(0)
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

  test("enables incremental vacuum idempotently for an existing observability database", async () => {
    ObservabilityStore.close()
    mkdirSync(ObservabilityStore.dir(), { recursive: true })
    const legacy = new Database(ObservabilityStore.pathName(), { create: true })
    legacy.exec("PRAGMA auto_vacuum=NONE")
    legacy.exec("CREATE TABLE existing_state (id INTEGER PRIMARY KEY)")
    legacy.close(true)

    await ObservabilityMigration.enableIncrementalVacuum()
    await ObservabilityMigration.enableIncrementalVacuum()

    const db = ObservabilityStore.initializeForMigration()
    const row = getRow<{ auto_vacuum: number }>(db, "PRAGMA auto_vacuum")
    expect(row.auto_vacuum).toBe(2)
  })

  test("synchronizes schema metadata for an existing observability database", async () => {
    const db = ObservabilityStore.initializeForMigration()
    runStatement(db, "INSERT OR REPLACE INTO obs_meta (key,value) VALUES ('schemaVersion', '2')")

    await ObservabilityMigration.synchronizeSchemaMetadata()
    await ObservabilityMigration.synchronizeSchemaMetadata()

    const row = getRow<{ value: string }>(db, "SELECT value FROM obs_meta WHERE key = 'schemaVersion'")
    expect(row.value).toBe("4")
  })

  test("adds resource cgroup columns to a v4 database idempotently", async () => {
    seedV4ObservabilityStore()

    await ObservabilityMigration.addResourceCgroupColumns()
    await ObservabilityMigration.addResourceCgroupColumns()

    const db = ObservabilityStore.initializeForMigration()
    const columns = new Set(
      allRows<{ name: string }>(db, "PRAGMA table_info(obs_resource_samples)").map((row) => row.name),
    )
    expect([...columns]).toEqual(
      expect.arrayContaining([
        "cgroup_current_bytes",
        "cgroup_high_bytes",
        "cgroup_max_bytes",
        "cgroup_peak_bytes",
        "cgroup_oom_count",
        "cgroup_oom_kill_count",
        "service_memory_rss_bytes",
        "service_memory_source",
        "service_memory_completeness",
      ]),
    )
    const indexes = new Set(
      allRows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'index'").map((row) => row.name),
    )
    expect(indexes).toContain("idx_obs_issues_status_last_seen")
    const row = getRow<{ value: string }>(db, "SELECT value FROM obs_meta WHERE key = 'schemaVersion'")
    expect(row.value).toBe("5")
  })

  test("backfills redaction across previously written canonical tables idempotently", async () => {
    seedLegacyPerformanceStore()
    await ObservabilityMigration.migrateLegacyPerformance()
    const db = ObservabilityStore.initializeForMigration()
    runStatement(
      db,
      "UPDATE obs_metrics SET labels_json = ?, redaction_json = '{}' WHERE metric_id = 'legacy_metric_1'",
      '{"authorization":"Bearer canonical-secret","path":"/?token=tok_canonical_metric_secret"}',
    )
    runStatement(
      db,
      "UPDATE obs_spans SET error_message = ?, attributes_json = ? WHERE span_id = 'legacy_span_1'",
      "failed ghp_canonicalspansecret",
      '{"password":"canonical-password"}',
    )
    runStatement(
      db,
      "UPDATE obs_resource_samples SET labels_json = ? WHERE sample_id = 'legacy_resource_1'",
      '{"command":"curl --token=tok_canonical_resource_secret"}',
    )
    runStatement(
      db,
      "UPDATE obs_issues SET title = ?, evidence_json = ? WHERE issue_id = 'legacy_issue_1'",
      "issue sk-canonical-secret",
      '{"authorization":"Bearer canonical-secret","stack":"private stack","scopeID":"sc_legacy"}',
    )
    runStatement(
      db,
      "UPDATE obs_browser_batches SET page_json = ? WHERE batch_id = 'legacy_batch_1'",
      '{"url":"https://example.test/?token=tok_canonical_browser_secret"}',
    )
    runStatement(
      db,
      `INSERT INTO obs_events (event_id,time,iso,type,cwd,source,module,data_json,redaction_json)
       VALUES ('legacy_event_1',1,'1970-01-01T00:00:00.001Z','legacy','/Users/private/project','backend','observability','{"cookie":"canonical-cookie"}','{}')`,
    )

    await ObservabilityMigration.redactCanonicalTelemetry()
    await ObservabilityMigration.redactCanonicalTelemetry()

    const canonical = JSON.stringify({
      metrics: allRows(db, "SELECT labels_json,redaction_json FROM obs_metrics"),
      spans: allRows(db, "SELECT error_message,attributes_json,redaction_json FROM obs_spans"),
      resources: allRows(db, "SELECT labels_json,redaction_json FROM obs_resource_samples"),
      issues: allRows(db, "SELECT title,evidence_json,redaction_json FROM obs_issues"),
      batches: allRows(db, "SELECT page_json FROM obs_browser_batches"),
      events: allRows(db, "SELECT cwd,data_json,redaction_json FROM obs_events"),
    })
    expect(canonical).not.toContain("canonical-secret")
    expect(canonical).not.toContain("canonical-password")
    expect(canonical).not.toContain("canonical-cookie")
    expect(canonical).not.toContain("private stack")
    expect(canonical).not.toContain("/Users/private/project")
    expect(canonical).toContain("sc_legacy")
  })

  test("redacts canonical telemetry across multiple bounded batches", async () => {
    const db = ObservabilityStore.initializeForMigration()
    const insert = db.prepare(
      `INSERT INTO obs_issues (issue_id,time,iso,severity,status,code,title,message,module,evidence_json,first_seen_time,last_seen_time,occurrence_count,fingerprint,redaction_json)
       VALUES (?1,1,'1970-01-01T00:00:00.001Z','warning','open','BATCH','Batch issue','Batch message','test',?2,1,1,1,?3,'{}')`,
    )
    try {
      db.transaction(() => {
        for (let index = 0; index < 1_001; index++) {
          insert.run(`batch-issue-${index}`, '{"authorization":"Bearer batch-secret"}', `batch-fingerprint-${index}`)
        }
      })()
    } finally {
      insert.finalize()
    }

    await ObservabilityMigration.redactCanonicalTelemetry()

    const row = getRow<{ count: number }>(
      db,
      "SELECT COUNT(*) AS count FROM obs_issues WHERE evidence_json LIKE '%batch-secret%'",
    )
    expect(row.count).toBe(0)
  })
})

function seedV4ObservabilityStore() {
  const initialized = ObservabilityStore.initializeForMigration()
  initialized.query("INSERT OR REPLACE INTO obs_meta (key,value) VALUES ('schemaVersion', '4')").run()
  ObservabilityStore.close()
  const db = new Database(ObservabilityStore.pathName())
  db.exec("DROP INDEX IF EXISTS idx_obs_issues_status_last_seen")
  for (const column of [
    "cgroup_current_bytes",
    "cgroup_high_bytes",
    "cgroup_max_bytes",
    "cgroup_peak_bytes",
    "cgroup_oom_count",
    "cgroup_oom_kill_count",
    "service_memory_rss_bytes",
    "service_memory_source",
    "service_memory_completeness",
  ]) {
    db.exec(`ALTER TABLE obs_resource_samples DROP COLUMN ${column}`)
  }
  db.close(true)
}

function seedLegacyPerformanceStore(traceShape: "snake" | "camel" | "both" = "snake") {
  const legacyPath = ObservabilityStore.legacyPerformancePath()
  mkdirSync(legacyPath.slice(0, legacyPath.lastIndexOf("/")), { recursive: true })
  const db = new Database(legacyPath, { create: true })
  const now = Date.now()
  const traceColumns =
    traceShape === "snake" ? "trace_id TEXT" : traceShape === "camel" ? "traceId TEXT" : "traceId TEXT,trace_id TEXT"
  try {
    db.exec(`
      CREATE TABLE perf_metrics (metric_id TEXT PRIMARY KEY,time INTEGER NOT NULL,iso TEXT NOT NULL,name TEXT NOT NULL,value REAL NOT NULL,unit TEXT NOT NULL,source TEXT NOT NULL,module TEXT NOT NULL,scope_id TEXT,session_id TEXT,message_id TEXT,call_id TEXT,${traceColumns},span_id TEXT,parent_span_id TEXT,rid TEXT,process_id TEXT,pid INTEGER,tool TEXT,labels_json TEXT NOT NULL DEFAULT '{}',sample_rate REAL NOT NULL DEFAULT 1);
      CREATE TABLE perf_spans (trace_id TEXT NOT NULL,span_id TEXT PRIMARY KEY,parent_span_id TEXT,name TEXT NOT NULL,module TEXT NOT NULL,source TEXT NOT NULL,start_time INTEGER NOT NULL,end_time INTEGER,duration_ms REAL,status TEXT NOT NULL,error_code TEXT,error_message TEXT,scope_id TEXT,session_id TEXT,message_id TEXT,call_id TEXT,rid TEXT,process_id TEXT,pid INTEGER,tool TEXT,attributes_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE perf_resource_samples (sample_id TEXT PRIMARY KEY,time INTEGER NOT NULL,iso TEXT NOT NULL,source TEXT NOT NULL,trace_id TEXT,scope_id TEXT,session_id TEXT,pid INTEGER,process_id TEXT,process_role TEXT NOT NULL DEFAULT 'unknown',cpu_user_micros REAL,cpu_system_micros REAL,cpu_utilization_ratio REAL,memory_rss_bytes INTEGER,memory_heap_total_bytes INTEGER,memory_heap_used_bytes INTEGER,memory_external_bytes INTEGER,memory_array_buffers_bytes INTEGER,event_loop_lag_ms REAL,event_loop_sample_window_ms REAL,app_read_bytes INTEGER,app_written_bytes INTEGER,app_read_ops INTEGER,app_write_ops INTEGER,os_read_bytes INTEGER,os_written_bytes INTEGER,os_available INTEGER,labels_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE perf_issues (issue_id TEXT PRIMARY KEY,time INTEGER NOT NULL,iso TEXT NOT NULL,severity TEXT NOT NULL,status TEXT NOT NULL,code TEXT NOT NULL,title TEXT NOT NULL,message TEXT NOT NULL,recommendation TEXT,module TEXT NOT NULL,trace_id TEXT,span_id TEXT,session_id TEXT,message_id TEXT,call_id TEXT,rid TEXT,evidence_json TEXT NOT NULL DEFAULT '{}',first_seen_time INTEGER NOT NULL,last_seen_time INTEGER NOT NULL,occurrence_count INTEGER NOT NULL,fingerprint TEXT NOT NULL);
      CREATE TABLE perf_browser_batches (batch_id TEXT PRIMARY KEY,received_time INTEGER NOT NULL,sent_at INTEGER NOT NULL,source TEXT NOT NULL,accepted INTEGER NOT NULL,rejected INTEGER NOT NULL,page_json TEXT NOT NULL DEFAULT '{}');
    `)
    if (traceShape === "both") {
      runStatement(
        db,
        `INSERT INTO perf_metrics (metric_id,time,iso,name,value,unit,source,module,traceId,trace_id,labels_json,sample_rate)
         VALUES ('legacy_metric_1',?1,?2,'http.request.duration',42,'ms','backend','server','trace_camel_fallback','trace_legacy','{"path":"/legacy?token=tok_legacy_metric_secret","authorization":"Bearer legacy-authorization-secret"}',1)`,
        now,
        new Date(now).toISOString(),
      )
    } else {
      const traceColumn = traceShape === "camel" ? "traceId" : "trace_id"
      runStatement(
        db,
        `INSERT INTO perf_metrics (metric_id,time,iso,name,value,unit,source,module,${traceColumn},labels_json,sample_rate)
         VALUES ('legacy_metric_1',?1,?2,'http.request.duration',42,'ms','backend','server','trace_legacy','{"path":"/legacy?token=tok_legacy_metric_secret","authorization":"Bearer legacy-authorization-secret"}',1)`,
        now,
        new Date(now).toISOString(),
      )
    }
    runStatement(
      db,
      `INSERT INTO perf_spans (trace_id,span_id,name,module,source,start_time,end_time,duration_ms,status,error_code,error_message,attributes_json)
       VALUES ('trace_legacy','legacy_span_1','http.request','server','backend',?1,?2,42,'ok','LEGACY_FAILURE','legacy failed with sk-legacy-secret','{}')`,
      now - 42,
      now,
    )
    runStatement(
      db,
      `INSERT INTO perf_resource_samples (sample_id,time,iso,source,trace_id,process_role,cpu_utilization_ratio,memory_rss_bytes,event_loop_sample_window_ms,labels_json)
       VALUES ('legacy_resource_1',?1,?2,'process','trace_legacy','server',0.1,1024,5000,'{"command":"curl --token=tok_legacy_resource_secret"}')`,
      now,
      new Date(now).toISOString(),
    )
    runStatement(
      db,
      `INSERT INTO perf_issues (issue_id,time,iso,severity,status,code,title,message,recommendation,module,trace_id,evidence_json,first_seen_time,last_seen_time,occurrence_count,fingerprint)
       VALUES ('legacy_issue_1',?1,?2,'warning','open','PERF_LEGACY','Legacy issue sk-legacy-secret','Legacy issue ghp_legacysecret','Inspect tok_legacy_secret','server','trace_legacy','{"stack":"Error: test\\n  at file.ts:1","scopeID":"sc_legacy","authorization":"Bearer legacy-authorization-secret","note":"ghp_legacysecret"}',?1,?1,1,'sk-legacy-secret')`,
      now,
      new Date(now).toISOString(),
    )
    runStatement(
      db,
      `INSERT INTO perf_browser_batches (batch_id,received_time,sent_at,source,accepted,rejected,page_json)
       VALUES ('legacy_batch_1',?1,?1,'browser',1,0,'{"url":"https://example.test/?token=tok_legacy_browser_secret"}')`,
      now,
    )
  } finally {
    db.close(true)
  }
}

type SqlBinding = string | number | bigint | boolean | null | Uint8Array

function allRows<Row = Record<string, unknown>>(db: Database, sql: string, ...params: SqlBinding[]): Row[] {
  const statement = db.prepare(sql)
  try {
    return statement.all(...params) as Row[]
  } finally {
    statement.finalize()
  }
}

function getRow<Row>(db: Database, sql: string, ...params: SqlBinding[]): Row {
  const statement = db.prepare(sql)
  try {
    return statement.get(...params) as Row
  } finally {
    statement.finalize()
  }
}

function runStatement(db: Database, sql: string, ...params: SqlBinding[]) {
  const statement = db.prepare(sql)
  try {
    return statement.run(...params)
  } finally {
    statement.finalize()
  }
}
