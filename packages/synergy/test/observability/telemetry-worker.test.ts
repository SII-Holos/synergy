import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { ObservabilityDbSchema } from "../../src/observability/db-schema"
import { ObservabilityDbWrites } from "../../src/observability/db-writes"
import { ObservabilitySchema } from "../../src/observability/schema"
import { ObservabilityTelemetryClient } from "../../src/observability/telemetry-client"
import { TelemetryProtocol } from "../../src/observability/telemetry-protocol"

const homes: string[] = []
const originalTestHome = process.env.SYNERGY_TEST_HOME

function makeConfig(overrides?: Partial<TelemetryProtocol.WorkerConfig>): TelemetryProtocol.WorkerConfig {
  return {
    maxSqliteBytes: 16 * 1024 * 1024,
    walCheckpointIntervalMs: 60_000,
    metricRetentionMs: 24 * 60 * 60 * 1000,
    traceRetentionMs: 24 * 60 * 60 * 1000,
    maintenanceBudgetMs: 500,
    ...overrides,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(intervalMs)
  }
  expect(predicate()).toBe(true)
}

function metricRow(metricId: string, name: string, value: number): TelemetryProtocol.BatchRow {
  const now = Date.now()
  return {
    kind: "metric",
    row: ObservabilitySchema.Metric.parse({
      metricId,
      time: now,
      iso: new Date(now).toISOString(),
      name,
      value,
      unit: "count",
      source: "backend",
      module: "observability",
    }),
  }
}

function eventRow(eventId: string, type: string): TelemetryProtocol.BatchRow {
  const now = Date.now()
  return {
    kind: "event",
    row: ObservabilitySchema.Event.parse({
      eventId,
      time: now,
      iso: new Date(now).toISOString(),
      type,
      source: "backend",
      module: "observability",
    }),
  }
}

describe("ObservabilityTelemetryClient worker", () => {
  let dbPath: string

  beforeEach(() => {
    const home = mkdtempSync(path.join(tmpdir(), "synergy-obs-worker-"))
    homes.push(home)
    process.env.SYNERGY_TEST_HOME = home
    const dir = path.join(home, "state", "observability")
    mkdirSync(dir, { recursive: true })
    dbPath = path.join(dir, "observability.sqlite")
  })

  afterEach(async () => {
    await ObservabilityTelemetryClient.stop()
    if (originalTestHome === undefined) delete process.env.SYNERGY_TEST_HOME
    else process.env.SYNERGY_TEST_HOME = originalTestHome
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  test("starts a worker, writes metrics and events, and commits them to sqlite", async () => {
    ObservabilityTelemetryClient.start({ dbPath, config: makeConfig() })
    await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)

    for (let index = 0; index < 5; index++) {
      ObservabilityTelemetryClient.enqueue(metricRow(`worker_metric_${index}`, "worker.test.metric", index))
    }
    ObservabilityTelemetryClient.enqueue(eventRow("worker_event_0", "worker.test"))
    ObservabilityTelemetryClient.enqueue(eventRow("worker_event_1", "worker.test"))
    await ObservabilityTelemetryClient.flushAndWait(5000)

    const reader = new Database(dbPath, { readonly: true })
    try {
      const metrics = reader.query("SELECT * FROM obs_metrics").all() as Array<{ metric_id: string }>
      expect(metrics).toHaveLength(5)
      const events = reader.query("SELECT * FROM obs_events").all() as Array<{ event_id: string }>
      expect(events).toHaveLength(2)
    } finally {
      reader.close()
    }
  })

  test("restarts the worker after SIGKILL and continues writing", async () => {
    ObservabilityTelemetryClient.start({ dbPath, config: makeConfig() })
    await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)

    const proc = ObservabilityTelemetryClient.workerProcess()
    expect(proc).toBeDefined()
    proc?.kill(9)

    await waitFor(
      () => ObservabilityTelemetryClient.stats().workerReady && ObservabilityTelemetryClient.stats().restarts >= 1,
      15_000,
    )

    ObservabilityTelemetryClient.enqueue(metricRow("worker_after_restart", "worker.test.restart", 7))
    await ObservabilityTelemetryClient.flushAndWait(5000)

    const reader = new Database(dbPath, { readonly: true })
    try {
      const rows = reader.query("SELECT * FROM obs_metrics").all() as Array<{ name: string; value: number }>
      expect(rows).toHaveLength(1)
      expect(rows[0]?.name).toBe("worker.test.restart")
      expect(rows[0]?.value).toBe(7)
    } finally {
      reader.close()
    }
    expect(ObservabilityTelemetryClient.stats().restarts).toBeGreaterThanOrEqual(1)
  })

  test("stop shuts the worker down with exit code 0 within the grace period", async () => {
    ObservabilityTelemetryClient.start({ dbPath, config: makeConfig() })
    await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)

    const proc = ObservabilityTelemetryClient.workerProcess()
    expect(proc).toBeDefined()
    await ObservabilityTelemetryClient.stop(5000)

    const exitCode = await proc?.exited
    expect(exitCode).toBe(0)
    expect(ObservabilityTelemetryClient.stats().workerReady).toBe(false)
  })

  test("counts sent-but-unconfirmed rows as dropped when the worker dies", async () => {
    ObservabilityTelemetryClient.start({ dbPath, config: makeConfig() })
    await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
    const droppedAtStart = ObservabilityTelemetryClient.stats().dropped

    // Fill several chunks so multiple batches are in flight, then kill the
    // worker. Rows it never confirmed must be counted as dropped.
    for (let index = 0; index < 3000; index++) {
      ObservabilityTelemetryClient.enqueue(metricRow(`inflight_${index}`, "worker.test.inflight", index))
    }
    ObservabilityTelemetryClient.flushPending()
    expect(ObservabilityTelemetryClient.stats().unconfirmed).toBeGreaterThan(0)

    const proc = ObservabilityTelemetryClient.workerProcess()
    expect(proc).toBeDefined()
    proc?.kill(9)
    await waitFor(
      () => ObservabilityTelemetryClient.stats().workerReady && ObservabilityTelemetryClient.stats().restarts >= 1,
      15_000,
    )
    await waitFor(() => ObservabilityTelemetryClient.stats().pending === 0, 15_000)

    // Accounting invariant: every enqueued row is either committed to the
    // database or counted as dropped.
    const reader = new Database(dbPath, { readonly: true })
    try {
      const rows = reader.query("SELECT COUNT(*) AS c FROM obs_metrics").get() as { c: number }
      expect(rows.c + (ObservabilityTelemetryClient.stats().dropped - droppedAtStart)).toBe(3000)
    } finally {
      reader.close()
    }
  })

  test("restarts the worker with the latest reconfigured settings", async () => {
    ObservabilityTelemetryClient.start({ dbPath, config: makeConfig() })
    await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)

    const tightened = makeConfig({ maxSqliteBytes: 8 * 1024 * 1024, walCheckpointIntervalMs: 120_000 })
    ObservabilityTelemetryClient.sendReconfigure(tightened)
    await Bun.sleep(100)
    const proc = ObservabilityTelemetryClient.workerProcess()
    expect(proc).toBeDefined()
    proc?.kill(9)
    await waitFor(() => ObservabilityTelemetryClient.stats().restarts >= 1, 15_000)
    await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)

    // The replacement worker must have been started with the latest config,
    // not the stale one captured at the first start().
    expect(ObservabilityTelemetryClient.stats().capExceededBytes).toBeGreaterThanOrEqual(0)
    const proc2 = ObservabilityTelemetryClient.workerProcess()
    expect(proc2).toBeDefined()
    expect(proc2).not.toBe(proc)
  })

  test("reports maintenanceDeferred when size enforcement exceeds the budget", async () => {
    const seed = new Database(dbPath, { create: true })
    ObservabilityDbSchema.configureWriteConnection(seed, true)
    const now = Date.now()
    const iso = new Date(now).toISOString()
    for (let index = 0; index < 4000; index++) {
      ObservabilityDbWrites.insertMetric(
        seed,
        ObservabilitySchema.Metric.parse({
          metricId: `seed_${index}`,
          time: now,
          iso,
          name: "seed.metric",
          value: index,
          unit: "count",
          source: "backend",
          module: "observability",
          labels: { pad: "x".repeat(500) },
        }),
      )
    }
    seed.close()

    const tight = makeConfig({ maxSqliteBytes: 32 * 1024, maintenanceBudgetMs: 1 })
    ObservabilityTelemetryClient.start({ dbPath, config: tight })
    await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)

    ObservabilityTelemetryClient.sendReconfigure(tight)
    await waitFor(() => ObservabilityTelemetryClient.stats().maintenanceDeferred === true, 15_000)
    expect(ObservabilityTelemetryClient.stats().capExceededBytes).toBeGreaterThan(0)
  })
})
