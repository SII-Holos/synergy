import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Observability } from "../../src/observability"
import { Storage } from "../../src/storage/storage"
import { PerformanceEvents } from "../../src/performance/events"
import { PerformanceIssues } from "../../src/performance/issues"
import { PerformanceDashboard } from "../../src/performance/dashboard"
import { PerformanceIngestion } from "../../src/performance/ingestion"
import { PerformanceConfig } from "../../src/performance/config"
import { PerformanceMetrics } from "../../src/performance/metrics"
import { PerformanceResources } from "../../src/performance/resources"
import { PerformanceStore } from "../../src/performance/store"
import { PerformanceWriter } from "../../src/performance/writer"
import { PerformanceTraceDetail } from "../../src/performance/trace-detail"
import { ProcessRegistry } from "../../src/process/registry"

const homes: string[] = []
const originalTestHome = process.env.SYNERGY_TEST_HOME

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "synergy-perf-"))
  homes.push(home)
  process.env.SYNERGY_TEST_HOME = home
  PerformanceStore.close()
  PerformanceConfig.refresh()
})

afterEach(() => {
  ProcessRegistry.reset()
  PerformanceStore.close()
  PerformanceConfig.refresh()
  if (originalTestHome === undefined) delete process.env.SYNERGY_TEST_HOME
  else process.env.SYNERGY_TEST_HOME = originalTestHome
})

describe.serial("performance observability store", () => {
  test("initializes required sqlite tables and stores attributed metrics", () => {
    PerformanceMetrics.record({
      name: "http.request.duration",
      value: 42,
      unit: "ms",
      module: "server",
      rid: "rid_test",
      labels: { method: "GET", path: "/global/performance/summary", status: 200 },
    })
    PerformanceStore.flush()

    const rows = PerformanceStore.queryMetrics({ since: 0, names: ["http.request.duration"] })
    expect(rows.some((row) => row.module === "server" && row.rid === "rid_test")).toBe(true)
    expect(new Set(PerformanceStore.meta().map((row) => row.key))).toEqual(
      new Set(["createdAt", "lastRetentionRunAt", "lastWalCheckpointAt", "schemaVersion"]),
    )
  })

  test("ingests safe browser batches and rejects unsafe resource entries", () => {
    const now = Date.now()
    const result = PerformanceIngestion.browserMetrics({
      sentAt: now,
      page: { pathTemplate: "/session/:id" },
      metrics: [{ name: "frontend.web_vital", value: 1200, unit: "ms", labels: { name: "LCP" } }],
      resourceEntries: [
        { name: "/global/performance/summary?token=secret", startTime: 1, duration: 12 },
        { name: "file:///private/data", startTime: 1, duration: 1 },
      ],
      longTasks: [{ startTime: 2, duration: 55, attribution: "longtask" }],
    })
    PerformanceStore.flush()

    expect(result.accepted).toBe(3)
    expect(result.rejected).toBe(1)
    const rows = PerformanceStore.queryMetrics({ since: 0 })
    expect(rows.some((row) => row.name === "frontend.web_vital")).toBe(true)
    expect(rows.some((row) => row.name === "frontend.long_task.duration")).toBe(true)
  })

  test("dashboard summary reports backend latency and frontend vitals", async () => {
    const now = Date.now()
    PerformanceMetrics.record({
      name: "http.request.duration",
      value: 100,
      unit: "ms",
      module: "server",
      labels: { method: "GET", path: "/api", status: 200 },
    })
    PerformanceIngestion.browserMetrics({
      sentAt: now,
      page: {},
      metrics: [{ name: "frontend.web_vital", value: 80, unit: "ms", labels: { name: "INP" } }],
    })
    PerformanceStore.flush()

    const summary = await PerformanceDashboard.summary({ windowMs: 300_000 })
    expect(summary.backend.requestCount).toBeGreaterThanOrEqual(1)
    expect(summary.backend.p95RequestMs).toBe(100)
    expect(summary.frontend.inpMs).toBe(80)
  })

  test("dashboard summary ranks provider and library durations from recorded metrics", async () => {
    PerformanceMetrics.record({
      name: "llm.stream.initialization.duration",
      value: 120,
      unit: "ms",
      module: "llm",
      labels: { provider: "openai", model: "gpt-test" },
    })
    PerformanceMetrics.record({
      name: "library.operation.duration",
      value: 30,
      unit: "ms",
      module: "library",
      labels: { operation: "select" },
    })
    PerformanceStore.flush()

    const summary = await PerformanceDashboard.summary({ windowMs: 300_000 })
    expect(summary.top.slowProviders[0]?.label).toBe("openai")
    expect(summary.top.slowLibrary[0]?.label).toBe("select")
  })

  test("dashboard summary separates server RSS from child process RSS contributors", async () => {
    const restore = ProcessRegistry.setProcessInspector(() => ({ alive: true, rssBytes: 8 * 1024 * 1024 }))
    try {
      const child = ProcessRegistry.create({ command: "next dev -p 8090", description: "Next dev server" })
      child.pid = 4321
      ProcessRegistry.markBackgrounded(child)

      PerformanceResources.snapshot()
      PerformanceStore.flush()

      const summary = await PerformanceDashboard.summary({ windowMs: 300_000 })
      expect(summary.resources.rssBytes).toBeGreaterThan(0)
      expect(summary.resources.rssBytes).not.toBe(8 * 1024 * 1024)
      expect(summary.resources.childProcessCount).toBe(1)
      expect(summary.resources.childProcessRssBytes).toBe(8 * 1024 * 1024)
      expect(summary.top.childProcesses[0]).toMatchObject({
        label: "next dev -p 8090",
        value: 8 * 1024 * 1024,
        unit: "bytes",
        processId: child.id,
        pid: 4321,
      })
    } finally {
      restore()
    }
  })

  test("upgrades legacy resource sample tables for process attribution", () => {
    mkdirSync(PerformanceStore.dir(), { recursive: true })
    const conn = new Database(PerformanceStore.pathName(), { create: true })
    try {
      conn.exec(`
        CREATE TABLE perf_resource_samples (
          sample_id TEXT PRIMARY KEY,
          time INTEGER NOT NULL,
          iso TEXT NOT NULL,
          source TEXT NOT NULL,
          pid INTEGER,
          cpu_user_micros REAL,
          cpu_system_micros REAL,
          cpu_utilization_ratio REAL,
          memory_rss_bytes INTEGER,
          memory_heap_total_bytes INTEGER,
          memory_heap_used_bytes INTEGER,
          memory_external_bytes INTEGER,
          memory_array_buffers_bytes INTEGER,
          event_loop_lag_ms REAL,
          event_loop_sample_window_ms INTEGER,
          app_read_bytes INTEGER,
          app_written_bytes INTEGER,
          app_read_ops INTEGER,
          app_write_ops INTEGER,
          os_read_bytes INTEGER,
          os_written_bytes INTEGER,
          os_available INTEGER NOT NULL DEFAULT 0,
          scope_id TEXT,
          session_id TEXT,
          trace_id TEXT
        );
      `)
      conn
        .prepare(
          `INSERT INTO perf_resource_samples (sample_id,time,iso,source,pid,memory_rss_bytes,event_loop_sample_window_ms,os_available)
           VALUES ('legacy_server', 1, '1970-01-01T00:00:00.001Z', 'process', 123, 4096, 1000, 1)`,
        )
        .run()
    } finally {
      conn.close(false)
    }

    const rows = PerformanceStore.resourceSince(0)
    expect(rows.find((row) => row.sample_id === "legacy_server")).toMatchObject({
      process_role: "server",
      process_id: null,
      labels_json: "{}",
    })
    expect(PerformanceStore.meta().find((row) => row.key === "schemaVersion")?.value).toBe("2")

    PerformanceResources.snapshot()
    PerformanceStore.flush()
    expect(PerformanceStore.latestResource({ processRole: "server" })?.memory_rss_bytes).toBeGreaterThan(0)
  })

  test("trace detail projects observability events without raw event data", async () => {
    const traceId = "perf_trace_safe_projection"
    await Observability.emit("tool.start", {
      traceId,
      tool: "bash",
      level: "info",
      data: { args: { command: "deploy --token=super-secret" }, output: "raw content" },
    })
    await PerformanceWriter.flush()

    const detail = await PerformanceTraceDetail.detail(traceId, { maxEvents: 10 })
    expect(detail.events.length).toBe(1)
    expect(detail.events[0].type).toBe("tool.start")
    expect(detail.events[0].dataKeys).toContain("args")
    expect(JSON.stringify(detail.events)).not.toContain("super-secret")
    expect(JSON.stringify(detail.events)).not.toContain("raw content")
  })

  test("coalesces repeated issue events while preserving occurrence counts", () => {
    let published = 0
    const unsubscribe = PerformanceEvents.subscribe((event) => {
      if (event.type === "performance.issue.raised") published++
    })

    PerformanceIssues.raise({
      code: "PERF_TEST_BACKPRESSURE",
      severity: "warning",
      module: "observability",
      title: "Backpressure",
      message: "Backpressure",
    })
    PerformanceIssues.raise({
      code: "PERF_TEST_BACKPRESSURE",
      severity: "warning",
      module: "observability",
      title: "Backpressure",
      message: "Backpressure",
    })
    unsubscribe()
    PerformanceStore.flush()

    const issues = PerformanceIssues.list({ module: "observability" }).filter(
      (issue) => issue.code === "PERF_TEST_BACKPRESSURE",
    )
    expect(published).toBe(1)
    expect(issues).toHaveLength(1)
    expect(issues[0].occurrenceCount).toBe(2)
  })

  test("records storage operation counters for readMany update remove list and scan", async () => {
    await Storage.write(["perf", "one"], { count: 1 })
    await Storage.write(["perf", "two"], { count: 2 })
    await Storage.readMany<{ count: number }>([
      ["perf", "one"],
      ["perf", "missing"],
    ])
    await Storage.update<{ count: number }>(["perf", "one"], (draft) => {
      draft.count++
    })
    await Storage.scan(["perf"])
    await Storage.list(["perf"])
    await Storage.remove(["perf", "two"])
    PerformanceStore.flush()

    const rows = PerformanceStore.queryMetrics({ since: 0, names: ["storage.operation.count"] })
    const operations = new Set(rows.map((row) => JSON.parse(row.labels_json).operation))
    expect(operations).toContain("readMany")
    expect(operations).toContain("update")
    expect(operations).toContain("scan")
    expect(operations).toContain("list")
    expect(operations).toContain("remove")
  })

  test("aggregates high-frequency count metrics before sqlite flush", () => {
    for (let i = 0; i < 5; i++) {
      PerformanceMetrics.record({
        name: "llm.stream.output_chars",
        value: 3,
        unit: "count",
        module: "llm",
        sessionID: "session_perf_aggregate",
        messageID: "message_perf_aggregate",
        labels: { kind: "text" },
      })
    }
    PerformanceStore.flush()

    const rows = PerformanceStore.queryMetrics({ since: 0, names: ["llm.stream.output_chars"] })
    const matching = rows.filter((row) => row.session_id === "session_perf_aggregate")
    expect(matching).toHaveLength(1)
    expect(matching[0].value).toBe(15)
  })

  test("resource sampler records finite process and app IO samples", () => {
    PerformanceResources.addRead(128)
    PerformanceResources.addWrite(256)
    PerformanceResources.snapshot()
    PerformanceStore.flush()

    const samples = PerformanceStore.resourceSince(0)
    expect(samples.length).toBeGreaterThan(0)
    const latest = samples.at(-1)!
    expect(Number.isFinite(latest.cpu_utilization_ratio)).toBe(true)
    expect(Number.isFinite(latest.memory_rss_bytes)).toBe(true)
    expect(Number.isFinite(latest.event_loop_lag_ms)).toBe(true)
    expect(latest.app_read_bytes ?? 0).toBeGreaterThanOrEqual(128)
    expect(latest.app_written_bytes ?? 0).toBeGreaterThanOrEqual(256)
  })

  test("writer buffers, flushes, and records backpressure drops", async () => {
    const file = path.join(process.env.SYNERGY_TEST_HOME!, "writer", "trace.jsonl")
    PerformanceWriter.append(file, '{"type":"one"}\n')
    expect(PerformanceWriter.stats().queueDepth).toBeGreaterThan(0)
    await PerformanceWriter.flush()
    expect(PerformanceWriter.stats().queueDepth).toBe(0)
    expect(await Bun.file(file).text()).toContain("one")

    for (let i = 0; i < 5_050; i++) PerformanceWriter.append(file, `{"type":"${i}"}\n`)
    await PerformanceWriter.flush()
    PerformanceStore.flush()
    const drops = PerformanceStore.queryMetrics({ since: 0, names: ["observability.writer.dropped"] })
    expect(drops.some((row) => JSON.parse(row.labels_json).reason === "queue_full")).toBe(true)
    expect(
      PerformanceIssues.list({ module: "observability" }).some(
        (issue) => issue.code === "PERF_OBSERVABILITY_WRITER_BACKPRESSURE",
      ),
    ).toBe(true)
  })

  test("snapshot records external and array_buffers metrics and raises issues when thresholds exceeded", () => {
    PerformanceConfig.refresh({
      observability: {
        performance: { thresholds: { highExternalBytes: 0, highArrayBuffersBytes: 0 } },
      },
    })
    PerformanceResources.snapshot()
    PerformanceStore.flush()

    const metrics = PerformanceStore.queryMetrics({
      since: 0,
      names: ["process.memory.external", "process.memory.array_buffers"],
    })
    expect(metrics.some((row) => row.name === "process.memory.external")).toBe(true)
    expect(metrics.some((row) => row.name === "process.memory.array_buffers")).toBe(true)

    const issues = PerformanceIssues.list({ module: "process" })
    expect(issues.some((issue) => issue.code === "PERF_MEMORY_HIGH_EXTERNAL")).toBe(true)
    expect(issues.some((issue) => issue.code === "PERF_MEMORY_HIGH_ARRAY_BUFFERS")).toBe(true)
  })
})

process.on("exit", () => {
  PerformanceStore.close()
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})
