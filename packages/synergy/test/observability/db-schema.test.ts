import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { ObservabilityDbSchema } from "../../src/observability/db-schema"

describe("ObservabilityDbSchema", () => {
  const homes: string[] = []
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "obs-dbschema-"))
    homes.push(dir)
    dbPath = path.join(dir, "obs.sqlite")
  })

  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  function pragmaNumber(db: Database, key: string) {
    const row = db.query(`PRAGMA ${key}`).get() as Record<string, number>
    return Number(Object.values(row ?? {})[0] ?? 0)
  }

  function pragmaValue(db: Database, key: string) {
    const row = db.query(`PRAGMA ${key}`).get() as Record<string, string | number>
    return Object.values(row ?? {})[0]
  }

  function tableNames(db: Database) {
    return (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    )
  }

  test("fresh connection creates the full schema with incremental auto_vacuum and WAL", () => {
    const db = new Database(dbPath, { create: true })
    ObservabilityDbSchema.configureWriteConnection(db, true)

    for (const table of [
      "obs_metrics",
      "obs_spans",
      "obs_events",
      "obs_resource_samples",
      "obs_issues",
      "obs_browser_batches",
      "obs_meta",
    ]) {
      expect(tableNames(db)).toContain(table)
    }
    expect(pragmaNumber(db, "auto_vacuum")).toBe(2)
    expect(String(pragmaValue(db, "journal_mode"))).toContain("wal")
    const meta = db.query("SELECT value FROM obs_meta WHERE key='schemaVersion'").get() as { value: string }
    expect(meta.value).toBe(String(ObservabilityDbSchema.schemaVersion))
    // Fresh path applies the v5 resource columns.
    const columns = (db.query("PRAGMA table_info(obs_resource_samples)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    )
    expect(columns).toContain("cgroup_current_bytes")
    db.close()
  })

  test("reopening an existing database is idempotent and keeps tables and meta", () => {
    const first = new Database(dbPath, { create: true })
    ObservabilityDbSchema.configureWriteConnection(first, true)
    first.close()

    const second = new Database(dbPath, { create: true })
    ObservabilityDbSchema.configureWriteConnection(second, false)
    expect(tableNames(second)).toContain("obs_metrics")
    const meta = second.query("SELECT value FROM obs_meta WHERE key='schemaVersion'").get() as { value: string }
    expect(meta.value).toBe(String(ObservabilityDbSchema.schemaVersion))
    second.close()
  })

  test("non-fresh path still sets WAL and busy timeout without re-applying v5", () => {
    const first = new Database(dbPath, { create: true })
    ObservabilityDbSchema.configureWriteConnection(first, true)
    first.close()

    const second = new Database(dbPath, { create: true })
    ObservabilityDbSchema.configureWriteConnection(second, false)
    expect(pragmaNumber(second, "busy_timeout")).toBe(5000)
    expect(String(pragmaValue(second, "journal_mode"))).toContain("wal")
    second.close()
  })
})
