import { Database } from "bun:sqlite"
import fs from "fs"
import path from "path"
import { watchManagedParent } from "../util/managed-parent"
import { ObservabilityDbSchema } from "./db-schema"
import { ObservabilityDbWrites } from "./db-writes"
import { ObservabilitySqliteMaintenance } from "./sqlite-maintenance"
import { TelemetryProtocol } from "./telemetry-protocol"

let db: Database | undefined
let config: TelemetryProtocol.WorkerConfig | undefined
let checkpointTimer: ReturnType<typeof setInterval> | undefined
let compactTimer: ReturnType<typeof setInterval> | undefined
let retentionTimer: ReturnType<typeof setInterval> | undefined
let deferredRetryTimer: ReturnType<typeof setTimeout> | undefined
let dbPathValue: string | undefined

const counters: {
  dropped: number
  committed: number
  capExceededBytes: number
  maintenanceDeferred: boolean
  lastFlushDurationMs: number
  lastError?: string
} = {
  dropped: 0,
  committed: 0,
  capExceededBytes: 0,
  maintenanceDeferred: false,
  lastFlushDurationMs: 0,
}
function send(message: TelemetryProtocol.WorkerToHost): void {
  process.send?.(message)
}

function sendStatus(): void {
  send({ type: "status", counters: { ...counters } })
}

function applyRow(row: TelemetryProtocol.BatchRow): void {
  if (!db) return
  switch (row.kind) {
    case "metric":
      ObservabilityDbWrites.insertMetric(db, row.row)
      break
    case "event":
      ObservabilityDbWrites.insertEvent(db, row.row)
      break
    case "span":
      ObservabilityDbWrites.upsertSpan(db, row.row)
      break
    case "resource":
      ObservabilityDbWrites.insertResource(db, row.row)
      break
    case "issue":
      ObservabilityDbWrites.insertIssue(db, row.row)
      break
    case "browser-batch":
      ObservabilityDbWrites.insertBrowserBatch(db, row.row)
      break
  }
}

function enforceSize(budgetMs: number, vacuumAlways = false): void {
  if (!db || !config) return
  if (deferredRetryTimer) {
    clearTimeout(deferredRetryTimer)
    deferredRetryTimer = undefined
  }
  const result = ObservabilitySqliteMaintenance.enforce({
    db,
    path: dbPathValue ?? "",
    maxBytes: config.maxSqliteBytes,
    tables: ObservabilityDbSchema.SIZE_CAP_TABLES,
    budgetMs,
    vacuumAlways,
  })
  counters.capExceededBytes = result.capExceededBytes
  counters.maintenanceDeferred = result.deferred ?? false
  if (result.deferred) {
    deferredRetryTimer = setTimeout(() => enforceSize(budgetMs, vacuumAlways), 5_000)
    deferredRetryTimer.unref()
  }
}

function scheduleTimers(): void {
  if (!config) return
  clearTimers()
  checkpointTimer = setInterval(() => {
    if (!db) return
    try {
      ObservabilityDbWrites.checkpoint(db)
    } catch (error) {
      counters.lastError = error instanceof Error ? error.message : String(error)
    }
  }, config.walCheckpointIntervalMs)
  checkpointTimer.unref()
  compactTimer = setInterval(
    () => enforceSize(config?.maintenanceBudgetMs ?? 500),
    Math.min(config.walCheckpointIntervalMs * 10, 600_000),
  )
  compactTimer.unref()
  retentionTimer = setInterval(() => {
    if (!db || !config) return
    const now = Date.now()
    try {
      ObservabilityDbWrites.retain(db, now, now - config.metricRetentionMs, now - config.traceRetentionMs)
      enforceSize(config.maintenanceBudgetMs, true)
    } catch (error) {
      counters.lastError = error instanceof Error ? error.message : String(error)
    }
  }, TelemetryProtocol.RETENTION_INTERVAL_MS)
  retentionTimer.unref()
}

function clearTimers(): void {
  if (checkpointTimer) clearInterval(checkpointTimer)
  if (compactTimer) clearInterval(compactTimer)
  if (retentionTimer) clearInterval(retentionTimer)
  if (deferredRetryTimer) clearTimeout(deferredRetryTimer)
  checkpointTimer = undefined
  compactTimer = undefined
  retentionTimer = undefined
  deferredRetryTimer = undefined
}

function handle(message: TelemetryProtocol.HostToWorker): void {
  switch (message.type) {
    case "start": {
      if (db) return
      fs.mkdirSync(path.dirname(message.dbPath), { recursive: true })
      const fresh = !fs.existsSync(message.dbPath)
      const conn = new Database(message.dbPath, { create: true })
      ObservabilityDbSchema.configureWriteConnection(conn, fresh)
      const autoVacuum = conn.query("PRAGMA auto_vacuum").get() as { auto_vacuum?: number } | undefined
      if (!fresh && Number(autoVacuum?.auto_vacuum ?? 0) === 0) {
        ObservabilitySqliteMaintenance.enableIncrementalVacuum(conn)
      }
      db = conn
      dbPathValue = message.dbPath
      config = message.config
      scheduleTimers()
      send({ type: "ready", pid: process.pid })
      break
    }
    case "batch": {
      if (!db) return
      const started = performance.now()
      try {
        db.transaction(() => {
          for (const row of message.rows) applyRow(row)
        })()
        counters.lastFlushDurationMs = performance.now() - started
        counters.committed += message.rows.length
      } catch (error) {
        counters.dropped += message.rows.length
        counters.lastError = error instanceof Error ? error.message : String(error)
      }
      sendStatus()
      break
    }
    case "flush": {
      send({ type: "ack", ackId: message.ackId })
      break
    }
    case "interrupt-spans": {
      if (!db) return
      try {
        ObservabilityDbWrites.interruptRunningSpans(db, message.reason)
      } catch (error) {
        counters.lastError = error instanceof Error ? error.message : String(error)
      }
      sendStatus()
      break
    }
    case "retain-now": {
      if (!db || !config) return
      const now = Date.now()
      try {
        ObservabilityDbWrites.retain(db, now, now - config.metricRetentionMs, now - config.traceRetentionMs)
        enforceSize(config.maintenanceBudgetMs)
      } catch (error) {
        counters.lastError = error instanceof Error ? error.message : String(error)
      }
      sendStatus()
      break
    }
    case "checkpoint": {
      if (!db) return
      try {
        ObservabilityDbWrites.checkpoint(db)
      } catch (error) {
        counters.lastError = error instanceof Error ? error.message : String(error)
      }
      sendStatus()
      break
    }
    case "reconfigure": {
      config = message.config
      scheduleTimers()
      if (db) enforceSize(message.config.maintenanceBudgetMs)
      sendStatus()
      break
    }
    case "shutdown": {
      gracefulExit()
      break
    }
  }
}

function gracefulExit(): void {
  clearTimers()
  if (db) {
    try {
      ObservabilityDbWrites.checkpoint(db)
    } catch {}
    db.close(false)
    db = undefined
  }
  process.exit(0)
}

process.on("message", (raw: unknown) => {
  const parsed = TelemetryProtocol.parseHostToWorker(raw)
  if (!parsed) return
  handle(parsed)
})

watchManagedParent({
  expectedParentPid: process.env.SYNERGY_OBSERVABILITY_PARENT_PID,
  onParentExit: () => gracefulExit(),
})

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => gracefulExit())
}
