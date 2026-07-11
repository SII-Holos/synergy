import { Database } from "bun:sqlite"
import fs from "fs"

export namespace ObservabilitySqliteMaintenance {
  const DELETE_CHUNK = 500
  const MAX_PASSES = 10_000
  const TARGET_RATIO = 0.95

  export interface Table {
    table: string
    orderBy: string
    where?: string
  }

  export function enforce(input: { db: Database; path: string; maxBytes: number; tables: ReadonlyArray<Table> }) {
    if (input.maxBytes <= 0) return { capExceededBytes: 0 }
    if (physicalFootprint(input.path) <= input.maxBytes) return { capExceededBytes: 0 }
    input.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    reclaimFreePages(input.db, input.path, input.maxBytes)
    if (physicalFootprint(input.path) <= input.maxBytes) return { capExceededBytes: 0 }
    deleteUntilUnderCap(input)
    return { capExceededBytes: Math.max(0, physicalFootprint(input.path) - input.maxBytes) }
  }

  export function enableIncrementalVacuum(db: Database) {
    if (pragmaNumber(db, "auto_vacuum") === 2) return
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    db.exec("PRAGMA auto_vacuum=INCREMENTAL")
    db.exec("VACUUM")
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  }

  export function physicalFootprint(path: string) {
    return [path, `${path}-wal`, `${path}-shm`].reduce((total, file) => total + fileSize(file), 0)
  }

  function deleteUntilUnderCap(input: { db: Database; path: string; maxBytes: number; tables: ReadonlyArray<Table> }) {
    for (let pass = 0; pass < MAX_PASSES && physicalFootprint(input.path) > input.maxBytes; pass++) {
      const targetLogicalBytes = Math.max(
        0,
        Math.floor(input.maxBytes * TARGET_RATIO) -
          sidecarFootprint(input.path) -
          2 * pragmaNumber(input.db, "page_size"),
      )
      if (logicalFootprint(input.db) <= targetLogicalBytes && pragmaNumber(input.db, "freelist_count") > 0) {
        reclaimFreePages(input.db, input.path, input.maxBytes)
        if (physicalFootprint(input.path) <= input.maxBytes) return
      }
      const table = oldestTable(input.db, input.tables)
      if (!table || deleteOldestRows(input.db, table) === 0) break
      if (pass % 8 === 7) reclaimFreePages(input.db, input.path, input.maxBytes)
    }
    reclaimFreePages(input.db, input.path, input.maxBytes)
  }

  function oldestTable(db: Database, tables: ReadonlyArray<Table>) {
    let selected: { table: Table; time: number } | undefined
    for (const table of tables) {
      const where = table.where ? `WHERE ${table.where}` : ""
      const row = db.prepare(`SELECT MIN(${table.orderBy}) AS time FROM ${table.table} ${where}`).get() as
        | { time?: number | null }
        | undefined
      if (row?.time === null || row?.time === undefined) continue
      if (!selected || row.time < selected.time) selected = { table, time: row.time }
    }
    return selected?.table
  }

  function deleteOldestRows(db: Database, table: Table) {
    const where = table.where ? `WHERE ${table.where}` : ""
    const countRow = db.prepare(`SELECT COUNT(*) AS count FROM ${table.table} ${where}`).get() as { count: number }
    const limit = Math.min(DELETE_CHUNK, Math.max(1, Math.floor(countRow.count / 10)))
    return db
      .prepare(
        `DELETE FROM ${table.table} WHERE rowid IN (SELECT rowid FROM ${table.table} ${where} ORDER BY ${table.orderBy} ASC LIMIT ?)`,
      )
      .run(limit).changes
  }

  function reclaimFreePages(db: Database, path: string, maxBytes: number) {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    const pageSize = pragmaNumber(db, "page_size")
    for (let pass = 0; pass < 16 && physicalFootprint(path) > maxBytes; pass++) {
      const freePages = pragmaNumber(db, "freelist_count")
      if (freePages <= 0) return
      const excessPages = Math.max(1, Math.ceil((physicalFootprint(path) - maxBytes) / Math.max(1, pageSize)) + 2)
      db.exec(`PRAGMA incremental_vacuum(${Math.min(freePages, excessPages)})`)
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    }
  }

  function logicalFootprint(db: Database) {
    const pageSize = pragmaNumber(db, "page_size")
    const pageCount = pragmaNumber(db, "page_count")
    const freelistCount = pragmaNumber(db, "freelist_count")
    return Math.max(0, pageCount - freelistCount) * pageSize
  }

  function pragmaNumber(db: Database, key: string) {
    const row = db.prepare(`PRAGMA ${key}`).get() as Record<string, number> | undefined
    return Number(Object.values(row ?? {})[0] ?? 0)
  }

  function sidecarFootprint(path: string) {
    return fileSize(`${path}-wal`) + fileSize(`${path}-shm`)
  }

  function fileSize(path: string) {
    try {
      return fs.statSync(path).size
    } catch {
      return 0
    }
  }
}
