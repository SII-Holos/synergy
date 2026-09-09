import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { ObservabilitySqliteMaintenance } from "../../src/observability/sqlite-maintenance"

describe("ObservabilitySqliteMaintenance budget", () => {
  const homes: string[] = []
  let dir: string
  let dbPath: string
  let db: Database

  const TABLES = [
    { table: "obs_metrics", orderBy: "time" },
    { table: "obs_events", orderBy: "time" },
  ] as const

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "obs-budget-"))
    homes.push(dir)
    dbPath = path.join(dir, "obs.sqlite")
    db = new Database(dbPath, { create: true })
    // Match production fresh-path pragma order (ObservabilityDbSchema.
    // configureWriteConnection): auto_vacuum must be set before
    // journal_mode=WAL or incremental_vacuum becomes a no-op.
    db.exec("PRAGMA auto_vacuum=INCREMENTAL")
    db.exec("PRAGMA journal_mode=WAL")
    db.exec(
      "CREATE TABLE obs_metrics (metric_id TEXT PRIMARY KEY,time INTEGER NOT NULL,name TEXT NOT NULL,value REAL NOT NULL,labels_json TEXT NOT NULL DEFAULT '{}')",
    )
    db.exec(
      "CREATE TABLE obs_events (event_id TEXT PRIMARY KEY,time INTEGER NOT NULL,type TEXT NOT NULL,data_json TEXT NOT NULL DEFAULT '{}')",
    )
  })

  afterEach(() => {
    db.close()
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  // WAL data only reaches the filesystem after commit, so fill in committed
  // batches and check the physical footprint between batches.
  function fillToExceed(maxBytes: number) {
    const insert = db.prepare("INSERT INTO obs_metrics VALUES (?,?,?,?,?)")
    let i = 0
    for (let batch = 0; batch < 100; batch++) {
      db.transaction(() => {
        for (let k = 0; k < 1000; k++, i++) {
          insert.run(`m${i}`, i, "test.budget", 1, `{"pad":"${"x".repeat(200)}"}`)
        }
      })()
      if (ObservabilitySqliteMaintenance.physicalFootprint(dbPath) > maxBytes) return
    }
    throw new Error("fill loop did not exceed cap")
  }

  test("returns deferred when the budget elapses before the cap is reached", () => {
    const maxBytes = 128 * 1024
    fillToExceed(maxBytes)
    expect(ObservabilitySqliteMaintenance.physicalFootprint(dbPath)).toBeGreaterThan(maxBytes)

    const result = ObservabilitySqliteMaintenance.enforce({
      db,
      path: dbPath,
      maxBytes,
      tables: TABLES,
      budgetMs: 1,
    })
    expect(result.capExceededBytes).toBeGreaterThan(0)
    expect(result.deferred).toBe(true)
  })

  test("converges to the cap across repeated budgeted passes without deferred", () => {
    const maxBytes = 128 * 1024
    fillToExceed(maxBytes)

    let deferred = true
    let pass = 0
    while (deferred && pass < 10) {
      const result = ObservabilitySqliteMaintenance.enforce({
        db,
        path: dbPath,
        maxBytes,
        tables: TABLES,
        budgetMs: 5000,
      })
      deferred = result.deferred ?? false
      pass++
    }
    expect(ObservabilitySqliteMaintenance.physicalFootprint(dbPath)).toBeLessThanOrEqual(maxBytes)
  })

  test("reports zero exceeded bytes immediately when already under cap", () => {
    const result = ObservabilitySqliteMaintenance.enforce({
      db,
      path: dbPath,
      maxBytes: 1024 * 1024,
      tables: TABLES,
      budgetMs: 500,
    })
    expect(result.capExceededBytes).toBe(0)
    expect(result.deferred).toBeUndefined()
  })
})
