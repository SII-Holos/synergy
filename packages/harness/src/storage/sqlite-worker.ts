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

// The authoritative store is orders of magnitude larger than either
// connection's defaults assume, so both connections ask for a memory map and a
// page cache sized for it. A negative cache_size is a size in KiB rather than a
// page count, so the cache keeps its byte size if the page size ever changes;
// SQLite's own default is -2000, two megabytes. Windows is left unmapped
// because it cannot truncate a memory-mapped file, and that silently failed
// shrink would defeat the incremental vacuum governing this store's capacity.
const MMAP_SIZE_BYTES = 268435456
const CACHE_SIZE_KIB = -65536

// A `PRAGMA name = value` that does not throw is not evidence the value took
// effect: SQLite caps `mmap_size` at its compile-time SQLITE_MAX_MMAP_SIZE,
// ignores it where memory-mapped I/O is unsupported, and ignores an unknown
// pragma entirely. Read each setting back and report the ones the engine did
// not honor instead of assuming the request landed. A rejected or clamped
// pragma must never throw and never fail startup.
function applySizePragmas(connection: Database) {
  if (process.platform !== "win32") applyReadBackPragma(connection, "mmap_size", MMAP_SIZE_BYTES)
  applyReadBackPragma(connection, "cache_size", CACHE_SIZE_KIB)
}

function applyReadBackPragma(connection: Database, name: "mmap_size" | "cache_size", requested: number) {
  let effective: number | undefined
  try {
    connection.run(`PRAGMA ${name} = ${requested}`)
    const row = connection.query(`PRAGMA ${name}`).get() as Record<string, number | bigint> | null
    const value = Object.values(row ?? {})[0]
    effective = value === undefined ? undefined : Number(value)
  } catch {
    effective = undefined
  }
  // cache_size has no compile-time cap, so any value other than the request
  // means the pragma never applied. A smaller mmap_size is SQLite's documented
  // clamp against the compile-time maximum and still maps memory, so only a
  // zero means memory-mapped I/O is unavailable on this host.
  const honored = name === "cache_size" ? effective === requested : (effective ?? 0) > 0
  if (!honored)
    process.stderr.write(
      `SQLite worker: PRAGMA ${name} = ${requested} not honored (effective ${effective ?? "unavailable"})\n`,
    )
}

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
      applySizePragmas(writer)
      reader = new Database(request.filename!, { readonly: true, strict: true, safeIntegers: true })
      reader.run("PRAGMA busy_timeout = 5000")
      reader.run("PRAGMA query_only = ON")
      applySizePragmas(reader)
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
          changed: SqliteMaintenance.enableIncrementalVacuum(writer, (stage) =>
            process.send?.({ id: request.id, stage } satisfies SqliteResponse),
          ),
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
