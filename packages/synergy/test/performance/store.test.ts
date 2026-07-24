import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Observability } from "../../src/observability"
import { Storage } from "../../src/storage/storage"
import { ObservabilityLiveEvents } from "../../src/observability/live-events"
import { ObservabilityIssues } from "../../src/observability/issues"
import { PerformanceDashboard } from "../../src/performance/dashboard"
import { ObservabilityBrowserMetrics } from "../../src/observability/browser-metrics"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { ObservabilityResources } from "../../src/observability/resources"
import { ObservabilityStore } from "../../src/observability/store"
import { ObservabilitySpans } from "../../src/observability/spans"
import { ObservabilityWriter } from "../../src/observability/writer"
import { PerformanceTraceDetail } from "../../src/performance/trace-detail"
import { PerformanceTimeline } from "../../src/performance/timeline"
import { ProcessRegistry } from "../../src/process/registry"

const homes: string[] = []
const originalTestHome = process.env.SYNERGY_TEST_HOME

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "synergy-perf-"))
  homes.push(home)
  process.env.SYNERGY_TEST_HOME = home
  ObservabilityStore.close()
  ObservabilityConfig.refresh()
})

afterEach(() => {
  ProcessRegistry.reset()
  ObservabilityStore.close()
  ObservabilityConfig.refresh()
  if (originalTestHome === undefined) delete process.env.SYNERGY_TEST_HOME
  else process.env.SYNERGY_TEST_HOME = originalTestHome
})

describe.serial("performance observability store", () => {
  test("initializes required sqlite tables and stores attributed metrics", () => {
    ObservabilityMetrics.record({
      name: "http.request.duration",
      value: 42,
      unit: "ms",
      module: "server",
      rid: "rid_test",
      labels: { method: "GET", path: "/global/performance/summary", status: 200 },
    })
    ObservabilityStore.flush()

    const rows = ObservabilityStore.queryMetrics({ since: 0, names: ["http.request.duration"] })
    expect(rows.some((row) => row.module === "server" && row.rid === "rid_test")).toBe(true)
    expect(new Set(ObservabilityStore.meta().map((row) => row.key))).toEqual(
      new Set(["createdAt", "lastRetentionRunAt", "lastWalCheckpointAt", "schemaVersion"]),
    )
  })

  test("ingests safe browser batches and rejects unsafe resource entries", () => {
    const now = Date.now()
    const result = ObservabilityBrowserMetrics.ingest({
      sentAt: now,
      page: { pathTemplate: "/session/:id" },
      metrics: [{ name: "frontend.web_vital", value: 1200, unit: "ms", labels: { name: "LCP" } }],
      resourceEntries: [
        { name: "/global/performance/summary/sk-live-secret?token=secret", startTime: 1, duration: 12 },
        { name: "file:///private/data", startTime: 1, duration: 1 },
      ],
      longTasks: [{ startTime: 2, duration: 55, attribution: "longtask" }],
    })
    ObservabilityStore.flush()

    expect(result.accepted).toBe(3)
    expect(result.rejected).toBe(1)
    const rows = ObservabilityStore.queryMetrics({ since: 0 })
    expect(rows.some((row) => row.name === "frontend.web_vital")).toBe(true)
    expect(rows.some((row) => row.name === "frontend.long_task.duration")).toBe(true)
    expect(JSON.stringify(rows)).not.toContain("sk-live-secret")
    expect(JSON.stringify(rows)).not.toContain("token=secret")
  })

  test("dashboard summary reports backend latency and frontend vitals", async () => {
    const now = Date.now()
    ObservabilityMetrics.record({
      name: "http.request.duration",
      value: 100,
      unit: "ms",
      module: "server",
      labels: { method: "GET", path: "/api", status: 200 },
    })
    ObservabilityBrowserMetrics.ingest({
      sentAt: now,
      page: {},
      metrics: [{ name: "frontend.web_vital", value: 80, unit: "ms", labels: { name: "INP" } }],
    })
    ObservabilityStore.flush()

    const summary = await PerformanceDashboard.summary({ windowMs: 300_000 })
    expect(summary.backend.requestCount).toBeGreaterThanOrEqual(1)
    expect(summary.backend.p95RequestMs).toBe(100)
    expect(summary.frontend.inpMs).toBe(80)
  })

  test("dashboard uses the newest frontend vital in the selected window", async () => {
    ObservabilityMetrics.record({
      name: "frontend.web_vital",
      value: 100,
      unit: "ms",
      module: "frontend",
      source: "browser",
      labels: { name: "LCP" },
    })
    await Bun.sleep(2)
    ObservabilityMetrics.record({
      name: "frontend.web_vital",
      value: 200,
      unit: "ms",
      module: "frontend",
      source: "browser",
      labels: { name: "LCP" },
    })
    ObservabilityStore.flush()

    const summary = await PerformanceDashboard.summary({ windowMs: 300_000 })
    expect(summary.frontend.lcpMs).toBe(200)
  })

  test("dashboard summary ranks provider and library durations from recorded metrics", async () => {
    ObservabilityMetrics.record({
      name: "llm.stream.initialization.duration",
      value: 120,
      unit: "ms",
      module: "llm",
      labels: { provider: "openai", model: "gpt-test" },
    })
    ObservabilityMetrics.record({
      name: "library.operation.duration",
      value: 30,
      unit: "ms",
      module: "library",
      labels: { operation: "select" },
    })
    ObservabilityStore.flush()

    const summary = await PerformanceDashboard.summary({ windowMs: 300_000 })
    expect(summary.top.slowProviders[0]?.label).toBe("openai")
    expect(summary.top.slowLibrary[0]?.label).toBe("select")
  })

  test("dashboard separates top child detail from complete current child aggregates", async () => {
    const restore = ProcessRegistry.setProcessInspector(() => ({ alive: true, rssBytes: 8 * 1024 * 1024 }))
    try {
      const children = Array.from({ length: 7 }, (_, index) => {
        const child = ProcessRegistry.create({ command: `next-${index} dev -p 8090 --token=super-secret` })
        child.pid = 4321 + index
        ProcessRegistry.markBackgrounded(child)
        return child
      })

      ObservabilityResources.snapshot()
      ObservabilityStore.flush()

      const summary = await PerformanceDashboard.summary({ windowMs: 300_000 })
      expect(summary.resources.rssBytes).toBeGreaterThan(0)
      expect(summary.resources.heapUsedBytes).toBeGreaterThanOrEqual(0)
      expect(summary.resources.externalBytes).toBeGreaterThanOrEqual(0)
      expect(summary.resources.arrayBuffersBytes).toBeGreaterThanOrEqual(0)
      expect(summary.resources.rssBytes).not.toBe(8 * 1024 * 1024)
      expect(summary.resources.childProcessCount).toBe(7)
      expect(summary.resources.measuredChildProcessCount).toBe(7)
      expect(summary.resources.childProcessRssBytes).toBe(7 * 8 * 1024 * 1024)
      expect(summary.resources.serviceMemory).toMatchObject({
        rssBytes: expect.any(Number),
        currentBytes: expect.any(Number),
        source: expect.stringMatching(/^(cgroup_v2|process_api)$/),
        completeness: expect.stringMatching(/^(full|partial)$/),
      })
      expect(summary.resources.owners.map((owner) => owner.owner)).toEqual([
        "control_plane",
        "agent",
        "policy",
        "plugin",
        "browser",
        "mcp",
        "local_process",
      ])
      expect(summary.resources.owners.find((owner) => owner.owner === "local_process")).toMatchObject({
        processCount: 7,
        measuredProcessCount: 7,
        currentBytes: 7 * 8 * 1024 * 1024,
        source: "process_registry",
        completeness: "full",
        attributes: {
          stdioOpen: 7,
          descendantPipeGraceMs: 0,
        },
      })
      expect(summary.top.childProcesses).toHaveLength(5)
      expect(summary.top.childProcesses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: expect.stringMatching(/^next-[0-6]$/),
            value: 8 * 1024 * 1024,
            unit: "bytes",
            processId: expect.stringMatching(/^proc_/),
            pid: expect.any(Number),
          }),
        ]),
      )
      expect(summary.top.childProcesses.every((item) => children.some((child) => child.id === item.processId))).toBe(
        true,
      )
      expect(JSON.stringify(ObservabilityStore.resourceSince(0))).not.toContain("super-secret")
      const childMetrics = ObservabilityStore.queryMetrics({
        since: 0,
        names: ["process.child.memory.rss"],
      })
      expect(JSON.stringify(childMetrics)).not.toContain("super-secret")
    } finally {
      restore()
    }
  })

  test("trace detail projects observability events without raw event data", async () => {
    const traceId = "perf_trace_safe_projection"
    await Observability.emit("tool.start", {
      traceId,
      tool: "bash",
      level: "info",
      data: { args: { command: "deploy --token=super-secret" }, output: "raw content" },
    })
    await ObservabilityWriter.flush()

    const detail = await PerformanceTraceDetail.detail(traceId, { maxEvents: 10 })
    expect(detail.events.length).toBe(1)
    expect(detail.events[0].type).toBe("tool.start")
    expect(detail.events[0].dataKeys).toContain("args")
    expect(JSON.stringify(detail.events)).not.toContain("super-secret")
    expect(JSON.stringify(detail.events)).not.toContain("raw content")
  })

  test("trace list returns distinct traces and applies kind filtering in sqlite", () => {
    const first = ObservabilitySpans.start({
      name: "tool.execution",
      module: "tool",
      traceId: "trace_distinct_tool",
      tool: "bash",
    })
    const second = ObservabilitySpans.start({
      name: "tool.phase",
      module: "tool",
      traceId: "trace_distinct_tool",
      parentSpanId: first?.spanId,
      tool: "bash",
    })
    ObservabilitySpans.end(second)
    ObservabilitySpans.end(first)
    const runtime = ObservabilitySpans.start({ name: "runtime.work", module: "observability", kind: "runtime" })
    ObservabilitySpans.end(runtime)
    ObservabilityStore.flush()

    const traces = PerformanceTraceDetail.list({ kind: "tool", limit: 1 })
    expect(traces.items).toHaveLength(1)
    expect(traces.items[0].traceId).toBe("trace_distinct_tool")
  })

  test("timeline honors the current configured bucket limit", () => {
    ObservabilityConfig.refresh({ observability: { performance: { maxTimelineBuckets: 50 } } })

    expect(() =>
      PerformanceTimeline.get({
        metric: "http.request.duration",
        windowMs: 100_000,
        bucketMs: 1_000,
      }),
    ).toThrow("configured bucket limit")
  })

  test("timeline auto-bucketing stays within the configured inclusive point limit", () => {
    const timeline = PerformanceTimeline.get({
      metric: "http.request.duration",
      windowMs: 15 * 60 * 1000,
    })

    expect(timeline.series[0]?.points.length).toBeLessThanOrEqual(ObservabilityConfig.current().maxTimelineBuckets)
  })

  test("coalesces repeated issue events while preserving occurrence counts", () => {
    let published = 0
    const unsubscribe = ObservabilityLiveEvents.subscribe((event) => {
      if (event.type === "issue.raised") published++
    })

    ObservabilityIssues.raise({
      code: "PERF_TEST_BACKPRESSURE",
      severity: "warning",
      module: "observability",
      title: "Backpressure",
      message: "Backpressure",
    })
    ObservabilityIssues.raise({
      code: "PERF_TEST_BACKPRESSURE",
      severity: "warning",
      module: "observability",
      title: "Backpressure",
      message: "Backpressure",
    })
    unsubscribe()
    ObservabilityStore.flush()

    const issues = ObservabilityIssues.list({ module: "observability" }).filter(
      (issue) => issue.code === "PERF_TEST_BACKPRESSURE",
    )
    expect(published).toBe(1)
    expect(issues).toHaveLength(1)
    expect(issues[0].occurrenceCount).toBe(2)
  })

  test("bounds issues to the selected window while keeping exact severity counts", async () => {
    const now = Date.now()
    ObservabilityIssues.raise({
      code: "PERF_OLD_WINDOW_ISSUE",
      severity: "critical",
      module: "observability",
      title: "Old issue",
      message: "Old issue",
    })
    ObservabilityStore.flush()
    ObservabilityStore.initializeForMigration()
      .query("UPDATE obs_issues SET last_seen_time = ? WHERE code = ?")
      .run(now - 60_000, "PERF_OLD_WINDOW_ISSUE")
    for (let index = 0; index < 25; index++) {
      ObservabilityIssues.raise({
        code: `PERF_WINDOW_ISSUE_${index}`,
        severity: index === 0 ? "critical" : "warning",
        module: "observability",
        title: `Window issue ${index}`,
        message: `Window issue ${index}`,
      })
    }
    ObservabilityStore.flush()

    const summary = await PerformanceDashboard.summary({ windowMs: 10_000 })

    expect(summary.issues).toHaveLength(20)
    expect(summary.health.openIssueCount).toBe(25)
    expect(summary.health.criticalIssueCount).toBe(1)
    expect(summary.issues.some((issue) => issue.code === "PERF_OLD_WINDOW_ISSUE")).toBe(false)
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
    ObservabilityStore.flush()

    const rows = ObservabilityStore.queryMetrics({ since: 0, names: ["storage.operation.count"] })
    const operations = new Set(rows.map((row) => JSON.parse(row.labels_json).operation))
    expect(operations).toContain("readMany")
    expect(operations).toContain("update")
    expect(operations).toContain("scan")
    expect(operations).toContain("list")
    expect(operations).toContain("remove")
  })

  test("aggregates high-frequency count metrics before sqlite flush", () => {
    const before = ObservabilityStore.stats()
    for (let i = 0; i < 5_000; i++) {
      ObservabilityMetrics.record({
        name: "llm.stream.output_chars",
        value: 3,
        unit: "count",
        module: "llm",
        sessionID: "session_perf_aggregate",
        messageID: "message_perf_aggregate",
        labels: { kind: "text" },
      })
    }
    ObservabilityStore.flush()

    const rows = ObservabilityStore.queryMetrics({ since: 0, names: ["llm.stream.output_chars"] })
    const matching = rows.filter((row) => row.session_id === "session_perf_aggregate")
    expect(matching).toHaveLength(1)
    expect(matching[0].value).toBe(15_000)
    expect(ObservabilityStore.stats().dropped).toBe(before.dropped)
  })

  test("resource sampler records finite process and app IO samples", () => {
    ObservabilityResources.addRead(128)
    ObservabilityResources.addWrite(256)
    ObservabilityResources.snapshot()
    ObservabilityStore.flush()

    const samples = ObservabilityStore.resourceSince(0)
    expect(samples.length).toBeGreaterThan(0)
    const latest = samples.at(-1)!
    expect(Number.isFinite(latest.cpu_utilization_ratio)).toBe(true)
    expect(Number.isFinite(latest.memory_rss_bytes)).toBe(true)
    expect(Number.isFinite(latest.event_loop_lag_ms)).toBe(true)
    expect(latest.app_read_bytes ?? 0).toBeGreaterThanOrEqual(128)
    expect(latest.app_written_bytes ?? 0).toBeGreaterThanOrEqual(256)
    expect(Number.isFinite(latest.service_memory_rss_bytes)).toBe(true)
    expect(latest.service_memory_source).toMatch(/^(cgroup_v2|process_api)$/)
    expect(latest.service_memory_completeness).toMatch(/^(full|partial)$/)
  })

  test("writer buffers, flushes, and records backpressure drops", async () => {
    const file = path.join(process.env.SYNERGY_TEST_HOME!, "writer", "trace.jsonl")
    ObservabilityConfig.refresh({ observability: { performance: { storage: { jsonlMirrorEnabled: true } } } })
    ObservabilityWriter.append(file, '{"type":"one"}\n')
    expect(ObservabilityWriter.stats().queueDepth).toBeGreaterThan(0)
    await ObservabilityWriter.flush()
    expect(ObservabilityWriter.stats().queueDepth).toBe(0)
    expect(await Bun.file(file).text()).toContain("one")

    for (let i = 0; i < 5_050; i++) ObservabilityWriter.append(file, `{"type":"${i}"}\n`)
    await ObservabilityWriter.flush()
    ObservabilityStore.flush()
    const drops = ObservabilityStore.queryMetrics({ since: 0, names: ["observability.writer.dropped"] })
    expect(drops.some((row) => JSON.parse(row.labels_json).reason === "queue_full")).toBe(true)
    expect(
      ObservabilityIssues.list({ module: "observability" }).some(
        (issue) => issue.code === "PERF_OBSERVABILITY_WRITER_BACKPRESSURE",
      ),
    ).toBe(true)
  })

  test("snapshot records external and array_buffers metrics and raises issues when thresholds exceeded", () => {
    ObservabilityConfig.refresh({
      observability: {
        performance: { thresholds: { highExternalBytes: 0, highArrayBuffersBytes: 0 } },
      },
    })
    ObservabilityResources.snapshot()
    ObservabilityStore.flush()

    const metrics = ObservabilityStore.queryMetrics({
      since: 0,
      names: ["process.memory.external", "process.memory.array_buffers"],
    })
    expect(metrics.some((row: { name: string }) => row.name === "process.memory.external")).toBe(true)
    expect(metrics.some((row: { name: string }) => row.name === "process.memory.array_buffers")).toBe(true)

    const issues = ObservabilityIssues.list({ module: "process" })
    expect(issues.some((issue: { code: string }) => issue.code === "PERF_MEMORY_HIGH_EXTERNAL")).toBe(true)
    expect(issues.some((issue: { code: string }) => issue.code === "PERF_MEMORY_HIGH_ARRAY_BUFFERS")).toBe(true)
  })
})

process.on("exit", () => {
  ObservabilityStore.close()
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})
