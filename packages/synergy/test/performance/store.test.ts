import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Observability } from "../../src/observability"
import { PerformanceDashboard } from "../../src/performance/dashboard"
import { PerformanceIngestion } from "../../src/performance/ingestion"
import { PerformanceConfig } from "../../src/performance/config"
import { PerformanceMetrics } from "../../src/performance/metrics"
import { PerformanceStore } from "../../src/performance/store"
import { PerformanceWriter } from "../../src/performance/writer"
import { PerformanceTraceDetail } from "../../src/performance/trace-detail"

const homes: string[] = []

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "synergy-perf-"))
  homes.push(home)
  process.env.SYNERGY_TEST_HOME = home
  PerformanceStore.close()
  PerformanceConfig.refresh()
})

describe("performance observability store", () => {
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

    const rows = PerformanceStore.queryMetrics({ since: Date.now() - 60_000, names: ["http.request.duration"] })
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
    const rows = PerformanceStore.queryMetrics({ since: now - 60_000 })
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

    const summary = await PerformanceDashboard.summary({ windowMs: 60_000 })
    expect(summary.backend.requestCount).toBeGreaterThanOrEqual(1)
    expect(summary.backend.p95RequestMs).toBe(100)
    expect(summary.frontend.inpMs).toBe(80)
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
})

process.on("exit", () => {
  PerformanceStore.close()
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})
