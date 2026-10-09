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
import { registerObservabilityMigrations } from "../../src/observability/migration"

test("empty telemetry startup completes together without creating a database, then recording creates the current schema", async () => {
  await using fixture = await migrationFixture({ env: { SYNERGY_OBSERVABILITY_INLINE: "1" } })
  await fixture.run(async () => {
    registerObservabilityMigrations()
    const writes = spyOn(Storage, "write")
    try {
      expect((await runMigrations({ output: "silent" })).completed).toBe(6)
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
    expect((await runMigrations({ output: "silent" })).completed).toBe(6)
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
    expect((await runMigrations({ output: "silent" })).completed).toBe(6)
    expect(db.query("SELECT name FROM pragma_table_info('obs_metrics') WHERE name='iso'").get()).toBeNull()
    expect(db.query("SELECT name FROM sqlite_master WHERE name='idx_obs_metrics_module_time'").get()).toBeNull()
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
      expect((await getMigrationStatus()).observability.pending).toHaveLength(6)
    } finally {
      stat.mockRestore()
    }
  })
})
