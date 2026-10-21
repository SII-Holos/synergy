import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { migrationFixture } from "../migration/fixture"
import { getMigrationStatus, runMigrations } from "../../src/migration"
import { Storage } from "../../src/storage/storage"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityStore } from "../../src/observability/store"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { ObservabilityIssues } from "../../src/observability/issues"
import { ObservabilityMigration, registerObservabilityMigrations } from "../../src/observability/migration"
import { ObservabilityResourceSchema } from "../../src/observability/resource-schema"

test("empty telemetry startup completes together without creating a database, then recording creates the current schema", async () => {
  await using fixture = await migrationFixture({ env: { SYNERGY_OBSERVABILITY_INLINE: "1" } })
  await fixture.run(async () => {
    registerObservabilityMigrations()
    const writes = spyOn(Storage, "write")
    try {
      expect((await runMigrations({ output: "silent" })).completed).toBe(7)
      expect(writes.mock.calls.filter(([key]) => key.join("/") === "meta/migration/log-observability")).toHaveLength(1)
      expect(await Bun.file(ObservabilityStore.pathName()).exists()).toBe(false)
    } finally {
      writes.mockRestore()
    }
    ObservabilityConfig.refresh({ observability: { performance: { enabled: true } } })
    ObservabilityMetrics.record({ name: "new.metric", value: 1, unit: "count", module: "observability" })
    ObservabilityStore.flush()
    expect(ObservabilityStore.queryMetrics({ since: 0, names: ["new.metric"] })).toHaveLength(1)
    expect(ObservabilityStore.meta().find((row) => row.key === "schemaVersion")?.value).toBe(
      String(ObservabilityStore.schemaVersion),
    )
  })
})

test("a legacy telemetry file still imports its records before completion", async () => {
  await using fixture = await migrationFixture({ env: { SYNERGY_OBSERVABILITY_INLINE: "1" } })
  await fixture.run(async () => {
    const legacyPath = ObservabilityStore.legacyPerformancePath()
    await fs.mkdir(path.dirname(legacyPath), { recursive: true })
    const legacy = new Database(legacyPath, { create: true })
    legacy.exec(
      "CREATE TABLE perf_browser_batches(batch_id TEXT,received_time INTEGER,sent_at INTEGER,source TEXT,accepted INTEGER,rejected INTEGER,page_json TEXT)",
    )
    legacy
      .query("INSERT INTO perf_browser_batches VALUES(?,?,?,?,?,?,?)")
      .run("retained", 1, 1, "browser", 2, 0, '{"route":"/workbench"}')
    legacy.close()
    registerObservabilityMigrations()
    expect((await runMigrations({ output: "silent" })).completed).toBe(7)
    const db = ObservabilityStore.initializeForMigration()
    expect(db.query("SELECT accepted,page_json FROM obs_browser_batches WHERE batch_id='retained'").get()).toEqual({
      accepted: 2,
      page_json: '{"route":"/workbench"}',
    })
    expect(await Bun.file(legacyPath).exists()).toBe(true)
  })
})

test("an existing canonical store still receives metric schema cleanup", async () => {
  await using fixture = await migrationFixture({ env: { SYNERGY_OBSERVABILITY_INLINE: "1" } })
  await fixture.run(async () => {
    const db = ObservabilityStore.initializeForMigration()
    db.exec("ALTER TABLE obs_metrics ADD COLUMN iso TEXT")
    db.exec("CREATE INDEX idx_obs_metrics_module_time ON obs_metrics(module,time)")
    registerObservabilityMigrations()
    expect((await runMigrations({ output: "silent" })).completed).toBe(7)
    expect(db.query("SELECT name FROM pragma_table_info('obs_metrics') WHERE name='iso'").get()).toBeNull()
    expect(db.query("SELECT name FROM sqlite_master WHERE name='idx_obs_metrics_module_time'").get()).toBeNull()
  })
})

test("upgrade suppresses only legacy open default aggregates without rewriting their attribution or lifetime", async () => {
  await using fixture = await migrationFixture({ env: { SYNERGY_OBSERVABILITY_INLINE: "1" } })
  await fixture.run(async () => {
    const db = ObservabilityStore.initializeForMigration()
    for (const [issueID, status, fingerprint] of [
      ["legacy_open", "open", "PERF_TOOL_STALLED:tool"],
      ["legacy_resolved", "resolved", "PERF_TOOL_STALLED:tool"],
      ["custom", "open", "owner:custom"],
      ["scoped", "open", "PERF_TOOL_STALLED:tool:scope:scope_first"],
    ]) {
      db.query(
        `INSERT INTO obs_issues (issue_id,time,iso,severity,status,code,title,message,module,scope_id,trace_id,evidence_json,first_seen_time,last_seen_time,occurrence_count,fingerprint)
         VALUES (?,1,'1970-01-01T00:00:00.001Z','warning',?,'PERF_TOOL_STALLED','Retained title','Retained message','tool','scope_first','trace_first','{"observedValue":40000}',1,2,7,?)`,
      ).run(issueID, status, fingerprint)
    }
    const retained = () =>
      db
        .query<ObservabilityStore.StoredIssue, []>("SELECT * FROM obs_issues ORDER BY issue_id")
        .all()
        .map(ObservabilityIssues.fromRow)
    const before = retained()
    const releasedLedger = {
      "20260705-observability-store-v2": 1,
      "20260711-observability-redaction-backfill": 1,
      "20260711-observability-incremental-vacuum": 1,
      "20260712-observability-schema-metadata-v4": 1,
      "20260722-observability-resource-cgroup-v5": 1,
      "20260814-observability-metric-slim-v6": 1,
    }
    const ledgerKey = ["meta", "migration", "log-observability"]
    await Storage.write(ledgerKey, releasedLedger)
    registerObservabilityMigrations()

    expect((await runMigrations({ output: "silent" })).completed).toBe(1)
    expect(retained()).toEqual(
      before.map((issue) =>
        issue.issueId === "legacy_open"
          ? {
              ...issue,
              status: "suppressed",
              evidence: {
                ...issue.evidence,
                suppressionReason:
                  "Legacy default fingerprint did not separate Scopes; historical attribution cannot be reconstructed.",
              },
            }
          : issue,
      ),
    )
    expect(
      (await Storage.read<Record<string, number>>(ledgerKey))["20261021-observability-issue-scope-attribution"],
    ).toBeGreaterThan(0)
    const upgraded = retained()
    await Storage.write(ledgerKey, releasedLedger)
    expect((await runMigrations({ output: "silent" })).completed).toBe(1)
    expect(retained()).toEqual(upgraded)
    expect((await runMigrations({ output: "silent" })).completed).toBe(0)
  })
})

test("a failed telemetry file proof leaves every completion pending", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    registerObservabilityMigrations()
    const stat = spyOn(fs, "lstat").mockRejectedValueOnce(
      Object.assign(new Error("telemetry unavailable"), { code: "EACCES" }),
    )
    try {
      await expect(runMigrations({ output: "silent" })).rejects.toThrow("telemetry unavailable")
      expect((await getMigrationStatus()).observability.pending).toHaveLength(7)
    } finally {
      stat.mockRestore()
    }
  })
})

test("resource migration retains write ownership between schema inspection and version publication", async () => {
  await using fixture = await migrationFixture({ env: { SYNERGY_OBSERVABILITY_INLINE: "1" } })
  await fixture.run(async () => {
    const db = ObservabilityStore.initializeForMigration()
    db.query("UPDATE obs_meta SET value='4' WHERE key='schemaVersion'").run()
    const writer = new Database(ObservabilityStore.pathName())
    writer.exec("PRAGMA busy_timeout=0")
    const write = () => writer.query("INSERT INTO obs_meta (key,value) VALUES ('concurrent-writer','retained')").run()
    const apply = ObservabilityResourceSchema.applyV5
    let blocked: unknown
    const inspect = spyOn(ObservabilityResourceSchema, "applyV5").mockImplementation((target) => {
      apply(target)
      try {
        write()
      } catch (error) {
        blocked = error
      }
    })
    try {
      await ObservabilityMigration.addResourceCgroupColumns()
      expect(blocked).toMatchObject({ code: "SQLITE_BUSY" })
      expect(db.query("SELECT value FROM obs_meta WHERE key='schemaVersion'").get()).toEqual({
        value: String(ObservabilityStore.schemaVersion),
      })
      write()
      expect(db.query("SELECT value FROM obs_meta WHERE key='concurrent-writer'").get()).toEqual({
        value: "retained",
      })
    } finally {
      inspect.mockRestore()
      writer.close()
    }
  })
})
