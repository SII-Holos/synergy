import { describe, expect, test } from "bun:test"
import { TelemetryProtocol } from "../../src/observability/telemetry-protocol"
import { ObservabilitySchema } from "../../src/observability/schema"

const workerConfig: TelemetryProtocol.WorkerConfig = {
  maxSqliteBytes: 250 * 1024 * 1024,
  walCheckpointIntervalMs: 60_000,
  metricRetentionMs: 24 * 60 * 60 * 1000,
  traceRetentionMs: 24 * 60 * 60 * 1000,
  maintenanceBudgetMs: 500,
}

function metricRow(id: string): TelemetryProtocol.BatchRow {
  return {
    kind: "metric",
    row: ObservabilitySchema.Metric.parse({
      metricId: id,
      time: 1_700_000_000_000,
      iso: "2023-11-14T22:13:20.000Z",
      name: "test.metric",
      value: 1,
      unit: "count",
      source: "backend",
      module: "observability",
    }),
  }
}

describe("TelemetryProtocol", () => {
  test("round-trips every HostToWorker variant", () => {
    const messages: TelemetryProtocol.HostToWorker[] = [
      { type: "start", dbPath: "/tmp/obs.sqlite", config: workerConfig },
      { type: "batch", rows: [metricRow("m1"), metricRow("m2")] },
      { type: "flush", ackId: 7 },
      { type: "interrupt-spans", reason: "previous_runtime_ended" },
      { type: "interrupt-spans", reason: "runtime_shutdown" },
      { type: "retain-now" },
      { type: "checkpoint" },
      { type: "reconfigure", config: { ...workerConfig, maxSqliteBytes: 1024 } },
      { type: "shutdown" },
    ]
    for (const message of messages) {
      const parsed = TelemetryProtocol.parseHostToWorker(JSON.parse(JSON.stringify(message)))
      expect(parsed).toEqual(message)
    }
  })

  test("round-trips every WorkerToHost variant", () => {
    const messages: TelemetryProtocol.WorkerToHost[] = [
      { type: "ready", pid: 4242 },
      { type: "ack", ackId: 0 },
      { type: "ack", ackId: 12 },
      {
        type: "status",
        counters: {
          dropped: 3,
          committed: 17,
          capExceededBytes: 4096,
          maintenanceDeferred: true,
          lastFlushDurationMs: 12,
        },
      },
      {
        type: "status",
        counters: {
          dropped: 0,
          committed: 0,
          capExceededBytes: 0,
          maintenanceDeferred: false,
          lastFlushDurationMs: 4,
          lastError: "disk full",
        },
      },
    ]
    for (const message of messages) {
      const parsed = TelemetryProtocol.parseWorkerToHost(JSON.parse(JSON.stringify(message)))
      expect(parsed).toEqual(message)
    }
  })

  test("accepts valid rows for every BatchRow kind", () => {
    const time = 1_700_000_000_000
    const iso = "2023-11-14T22:13:20.000Z"
    const rows: TelemetryProtocol.BatchRow[] = [
      metricRow("m_valid"),
      {
        kind: "event",
        row: ObservabilitySchema.Event.parse({
          eventId: "e1",
          time,
          iso,
          type: "test",
          source: "backend",
          module: "observability",
        }),
      },
      {
        kind: "span",
        row: ObservabilitySchema.Span.parse({
          traceId: "trc_1",
          spanId: "sp_1",
          kind: "tool",
          name: "test",
          module: "observability",
          source: "backend",
          startTime: time,
          lastActivityTime: time,
        }),
      },
      {
        kind: "resource",
        row: ObservabilitySchema.ResourceSample.parse({
          sampleId: "rs_1",
          time,
          iso,
          source: "backend",
          process: { role: "server" },
          eventLoop: { sampleWindowMs: 100 },
        }),
      },
      {
        kind: "issue",
        row: ObservabilitySchema.Issue.parse({
          issueId: "is_1",
          time,
          iso,
          severity: "warning",
          code: "TEST",
          title: "t",
          message: "m",
          module: "observability",
          firstSeenTime: time,
          lastSeenTime: time,
          occurrenceCount: 1,
          fingerprint: "TEST",
        }),
      },
      {
        kind: "browser-batch",
        row: { batchId: "bb_1", receivedTime: time, sentAt: time, accepted: 1, rejected: 0, page: { path: "/x" } },
      },
    ]
    for (const row of rows) {
      const parsed = TelemetryProtocol.parseHostToWorker({ type: "batch", rows: [row] })
      expect(parsed?.type).toBe("batch")
      expect(parsed && parsed.type === "batch" ? parsed.rows[0] : undefined).toEqual(row)
    }
  })

  test("rejects an unknown BatchRow kind", () => {
    const parsed = TelemetryProtocol.parseHostToWorker({
      type: "batch",
      rows: [{ kind: "mystery", row: { metricId: "x" } }],
    })
    expect(parsed).toBeUndefined()
  })

  test("rejects a batch with zero rows", () => {
    expect(TelemetryProtocol.parseHostToWorker({ type: "batch", rows: [] })).toBeUndefined()
  })

  test("rejects malformed messages without throwing", () => {
    expect(TelemetryProtocol.parseHostToWorker({ type: "nope" })).toBeUndefined()
    expect(TelemetryProtocol.parseHostToWorker(undefined)).toBeUndefined()
    expect(TelemetryProtocol.parseHostToWorker("start")).toBeUndefined()
    expect(TelemetryProtocol.parseHostToWorker({ type: "flush", ackId: -1 })).toBeUndefined()
  })

  test("validates WorkerConfig bounds", () => {
    expect(TelemetryProtocol.WorkerConfigSchema.safeParse(workerConfig).success).toBe(true)
    expect(
      TelemetryProtocol.WorkerConfigSchema.safeParse({ ...workerConfig, walCheckpointIntervalMs: 500 }).success,
    ).toBe(false)
    expect(TelemetryProtocol.WorkerConfigSchema.safeParse({ ...workerConfig, metricRetentionMs: 1000 }).success).toBe(
      false,
    )
    expect(TelemetryProtocol.WorkerConfigSchema.safeParse({ ...workerConfig, maxSqliteBytes: 0 }).success).toBe(false)
    expect(TelemetryProtocol.WorkerConfigSchema.safeParse({ ...workerConfig, extra: 1 }).success).toBe(false)
  })

  test("BATCH_CHUNK_ROWS is 1000", () => {
    expect(TelemetryProtocol.BATCH_CHUNK_ROWS).toBe(1000)
  })
  test("estimates row bytes without serializing rows", () => {
    expect(TelemetryProtocol.estimateRowBytes(metricRow("m_size"))).toBeGreaterThan(100)
    // Attribute strings are capped at 4096 chars by the redaction schema, so
    // stay within that bound while still proving large payloads inflate the
    // estimated batch size.
    const bigEvent: TelemetryProtocol.BatchRow = {
      kind: "event",
      row: ObservabilitySchema.Event.parse({
        eventId: "e_big",
        time: 1_700_000_000_000,
        iso: "2023-11-14T22:13:20.000Z",
        type: "test",
        source: "backend",
        module: "observability",
        data: { payload: "x".repeat(4096) },
      }),
    }
    expect(TelemetryProtocol.estimateRowBytes(bigEvent)).toBeGreaterThan(8000)
  })
  test("BATCH_MAX_BYTES is bounded to 2 MiB", () => {
    expect(TelemetryProtocol.BATCH_MAX_BYTES).toBe(2 * 1024 * 1024)
  })
})
