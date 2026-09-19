import { initializeSqliteEngine } from "./sqlite-engine"
import { Database } from "bun:sqlite"
import { SqliteMaintenance } from "./sqlite-maintenance"
import { watchManagedParent } from "../util/managed-parent"
import type { SqliteRequest, SqliteResponse } from "./sql-contract"

// SQLite creates the database and its WAL sidecars (-wal/-shm) directly,
// outside AtomicFile's private mode; a restrictive umask keeps every storage
// file at owner-only permissions no matter when SQLite recreates them.
if (process.platform !== "win32") process.umask(0o077)

let writer: Database | undefined
let reader: Database | undefined
let filename: string | undefined

if (!process.send) throw new Error("SQLite worker requires a parent IPC channel")

process.on("message", (request: SqliteRequest) => {
  const response: SqliteResponse = { id: request.id }
  try {
    if (request.action === "open") {
      writer = new Database(request.filename!, {
        create: !request.readonly,
        readonly: request.readonly,
        strict: true,
        safeIntegers: true,
      })
      writer.run("PRAGMA busy_timeout = 5000")
      writer.run("PRAGMA foreign_keys = ON")
      if (!request.readonly) {
        // SQLite records the auto-vacuum mode in the database header while the
        // file is still empty, so a new database must declare it before the WAL
        // journal creates that header. An existing non-empty database keeps its
        // current mode here and only converts through a VACUUM.
        writer.run("PRAGMA auto_vacuum = INCREMENTAL")
        writer.run("PRAGMA journal_mode = WAL")
        writer.run("PRAGMA synchronous = FULL")
        // The WAL is recycled by the automatic PASSIVE checkpoint; this bounds
        // how much disk it may occupy before that checkpoint shortens the file,
        // which is what the scheduled reclaim used to force with a blocking
        // TRUNCATE checkpoint.
        writer.run("PRAGMA journal_size_limit = 67108864")
      }
      reader = new Database(request.filename!, { readonly: true, strict: true, safeIntegers: true })
      reader.run("PRAGMA busy_timeout = 5000")
      reader.run("PRAGMA query_only = ON")
      filename = request.filename
    } else if (request.action === "ping") {
      // Liveness probes answer from the event loop without touching SQLite, so
      // they succeed whenever this worker is able to serve any request at all.
      response.rows = []
    } else if (request.action === "close") {
      reader?.close()
      writer?.close()
      reader = undefined
      writer = undefined
      filename = undefined
    } else if (request.action === "maintain") {
      if (!writer || !filename) throw new Error("SQLite connection is not open")
      const operation = request.maintain!.operation
      if (operation === "enable-incremental-vacuum") {
        response.maintain = {
          changed: SqliteMaintenance.enableIncrementalVacuum(writer),
          autoVacuum: SqliteMaintenance.autoVacuumMode(writer),
          releasedPages: 0,
          freelistPages: 0,
        }
      } else {
        const result = SqliteMaintenance.reclaim(writer, filename, { maxPages: request.maintain!.maxPages })
        response.maintain = { changed: result.releasedPages > 0, ...result }
      }
    } else {
      const connection = request.reader ? reader : writer
      if (!connection) throw new Error("SQLite connection is not open")
      response.rows = connection.query(request.statement!).all(...(request.values ?? [])) as NonNullable<
        SqliteResponse["rows"]
      >
    }
  } catch (error) {
    response.error = {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
    }
  }
  process.send?.(response)
})

process.on("disconnect", () => process.exit(0))
watchManagedParent({
  expectedParentPid: process.env.SYNERGY_STORAGE_PARENT_PID,
  onParentExit: () => process.exit(0),
})

initializeSqliteEngine()
