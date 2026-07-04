import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { PerformanceConfig } from "../../src/performance/config"
import { PerformanceMetrics } from "../../src/performance/metrics"
import { PerformanceStore } from "../../src/performance/store"
import { Server } from "../../src/server/server"

const homes: string[] = []

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "synergy-perf-route-"))
  homes.push(home)
  process.env.SYNERGY_TEST_HOME = home
  PerformanceStore.close()
  PerformanceConfig.refresh()
})

describe("performance routes", () => {
  test("summary returns dashboard shape without project scope", async () => {
    PerformanceMetrics.record({
      name: "http.request.duration",
      value: 25,
      unit: "ms",
      module: "server",
      labels: { method: "GET", path: "/global/performance/summary", status: 200 },
    })
    PerformanceStore.flush()

    const response = await Server.App().request("/global/performance/summary?windowMs=60000")
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.health.status).toBeDefined()
    expect(body.backend.requestCount).toBeGreaterThanOrEqual(1)
    expect(body.top.slowRoutes).toBeArray()
  })

  test("browser metric ingestion validates, redacts, and reports accepted counts", async () => {
    const response = await Server.App().request("/global/performance/browser-metrics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sentAt: Date.now(),
        page: { pathTemplate: "/session/:id" },
        metrics: [{ name: "frontend.web_vital", value: 1.2, unit: "ms", labels: { name: "CLS" } }],
        resourceEntries: [{ name: "/global/session?token=secret", startTime: 1, duration: 10 }],
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.accepted).toBe(2)
    expect(body.rejected).toBe(0)
    expect(body.batchId).toStartWith("brb_")
  })

  test("performance routes return stable error codes for invalid requests", async () => {
    const invalidSummary = await Server.App().request("/global/performance/summary?windowMs=0")
    expect(invalidSummary.status).toBe(400)
    expect((await invalidSummary.json()).code).toBe("PERF_INVALID_QUERY")

    const invalidBatch = await Server.App().request("/global/performance/browser-metrics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sentAt: Date.now(), page: {}, metrics: [{ name: "bad", value: "nope" }] }),
    })
    expect(invalidBatch.status).toBe(400)
    expect((await invalidBatch.json()).code).toBe("PERF_INVALID_METRIC_BATCH")
  })

  test("trace detail returns stable not-found error", async () => {
    const response = await Server.App().request("/global/performance/traces/not-present")
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.code).toBe("PERF_TRACE_NOT_FOUND")
  })

  test("timeline enforces allowed metrics and bucket limits", async () => {
    const now = Date.now()
    const from = new Date(now - 10_000).toISOString()
    const to = new Date(now).toISOString()

    const invalidMetric = await Server.App().request(
      `/global/performance/timeline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&metric=unknown.metric`,
    )
    expect(invalidMetric.status).toBe(400)
    expect((await invalidMetric.json()).code).toBe("PERF_INVALID_QUERY")

    const tooManyBuckets = await Server.App().request(
      `/global/performance/timeline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&bucketMs=1`,
    )
    expect(tooManyBuckets.status).toBe(400)
    expect((await tooManyBuckets.json()).code).toBe("PERF_TOO_MANY_BUCKETS")
  })

  test("capped metric queries preserve newest rows and summary exposes partial quality", async () => {
    const now = Date.now()
    const conn = PerformanceStore.open()
    expect(conn).toBeDefined()
    const insert = conn!.prepare(
      `INSERT INTO perf_metrics (metric_id,time,iso,name,value,unit,source,module,labels_json,sample_rate)
       VALUES (?1,?2,?3,'http.request.duration',?4,'ms','backend','server',?5,1)`,
    )
    const insertMetrics = conn!.transaction(() => {
      for (let index = 0; index < 50_002; index++) {
        const time = now - 50_001 + index
        insert.run(
          `met-cap-${index.toString().padStart(5, "0")}`,
          time,
          new Date(time).toISOString(),
          index,
          JSON.stringify({ path: `/route-${index}` }),
        )
      }
    })
    insertMetrics()

    const newest = PerformanceStore.queryMetrics({
      since: now - 60_000,
      names: ["http.request.duration"],
      limit: 3,
      newestFirst: true,
    })
    expect(newest.map((row) => row.value)).toEqual([49_999, 50_000, 50_001])

    const summary = await Server.App().request("/global/performance/summary?windowMs=86400000")
    expect(summary.status).toBe(200)
    const body = await summary.json()
    expect(body.quality).toMatchObject({ truncated: true, partial: true })
    expect(body.top.slowRoutes.some((item: { label: string }) => item.label === "/route-50001")).toBe(true)
    expect(body.top.slowRoutes.every((item: { label: string }) => item.label !== "/route-0")).toBe(true)
  })

  test("timeline returns chart metrics with aggregation metadata", async () => {
    const now = Date.now()
    PerformanceMetrics.record({ name: "http.request.duration", value: 10, unit: "ms", module: "server" })
    PerformanceMetrics.record({ name: "http.request.duration", value: 40, unit: "ms", module: "server" })
    PerformanceMetrics.record({
      name: "process.cpu.utilization",
      value: 0.2,
      unit: "ratio",
      module: "process",
      source: "process",
    })
    PerformanceMetrics.record({ name: "session.turn.duration", value: 25, unit: "ms", module: "session" })
    PerformanceMetrics.record({ name: "storage.operation.count", value: 1, unit: "count", module: "storage" })
    PerformanceStore.flush()

    const from = new Date(now - 1_000).toISOString()
    const to = new Date(now + 2_000).toISOString()
    const metrics = [
      "http.request.duration",
      "process.cpu.utilization",
      "session.turn.duration",
      "storage.operation.count",
    ]
      .map((metric) => `metric=${encodeURIComponent(metric)}`)
      .join("&")
    const response = await Server.App().request(
      `/global/performance/timeline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&bucketMs=1000&${metrics}`,
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    const names = body.series.map((series: { name: string }) => series.name)
    expect(names).toEqual(
      expect.arrayContaining([
        "http.request.duration",
        "process.cpu.utilization",
        "session.turn.duration",
        "storage.operation.count",
      ]),
    )
    const http = body.series.find((series: { name: string }) => series.name === "http.request.duration")
    expect(http.unit).toBe("ms")
    expect(http.kind).toBe("duration")
    expect(http.stat).toBe("p95")
    expect(http.sampleCount).toBeGreaterThanOrEqual(2)
    expect(
      http.points.some(
        (point: { value: number | null; sampleCount?: number }) => point.value === 40 && point.sampleCount === 2,
      ),
    ).toBe(true)
    const pointTimes = http.points.map((point: { time: number }) => point.time)
    expect(pointTimes).toEqual([...pointTimes].sort((a, b) => a - b))
    expect(http.points.some((point: { value: number | null }) => point.value === null)).toBe(true)
  })

  test("timeline rejects unknown metric but accepts chart metric names", async () => {
    const now = Date.now()
    const from = new Date(now - 1_000).toISOString()
    const to = new Date(now + 1_000).toISOString()
    const invalid = await Server.App().request(
      `/global/performance/timeline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&metric=unknown.metric`,
    )
    expect(invalid.status).toBe(400)

    for (const metric of [
      "process.memory.heap_total",
      "session.turn.active",
      "storage.read.bytes",
      "llm.request.duration",
      "tool.execution.count",
    ]) {
      const response = await Server.App().request(
        `/global/performance/timeline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&metric=${encodeURIComponent(metric)}`,
      )
      expect(response.status).toBe(200)
    }
  })

  test("frontend ingestion preserves sanitized route labels for slow frontend ranking", async () => {
    const response = await Server.App().request("/global/performance/browser-metrics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sentAt: Date.now(),
        page: { routeName: "Session Detail", pathTemplate: "/session/:id?token=secret" },
        metrics: [],
        resourceEntries: [{ name: "/global/session?token=secret", startTime: 1, duration: 80 }],
        longTasks: [{ startTime: 2, duration: 120, attribution: "script" }],
      }),
    })
    expect(response.status).toBe(200)
    PerformanceStore.flush()

    const summary = await Server.App().request("/global/performance/summary?windowMs=60000")
    expect(summary.status).toBe(200)
    const body = await summary.json()
    expect(body.top.slowFrontend.some((item: { label: string }) => item.label === "Session Detail")).toBe(true)
    expect(body.top.slowFrontend.every((item: { label: string }) => !item.label.includes("token"))).toBe(true)
  })

  test("timeline filters by providerID and returns ascending nullable buckets", async () => {
    const now = Date.now()
    PerformanceMetrics.record({
      name: "llm.call.duration",
      value: 10,
      unit: "ms",
      module: "llm",
      labels: { providerID: "provider-a" },
    })
    PerformanceMetrics.record({
      name: "llm.call.duration",
      value: 20,
      unit: "ms",
      module: "llm",
      labels: { providerID: "provider-b" },
    })
    PerformanceStore.flush()

    const from = new Date(now - 1_000).toISOString()
    const to = new Date(now + 2_000).toISOString()
    const response = await Server.App().request(
      `/global/performance/timeline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&bucketMs=1000&metric=llm.call.duration&providerID=provider-a`,
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    const pointTimes = body.series[0].points.map((point: { time: number }) => point.time)
    expect(pointTimes).toEqual([...pointTimes].sort((a, b) => a - b))
    expect(body.series[0].points.some((point: { value: number | null }) => point.value === 10)).toBe(true)
    expect(body.series[0].points.some((point: { value: number | null }) => point.value === 20)).toBe(false)
    expect(body.series[0].points.some((point: { value: number | null }) => point.value === null)).toBe(true)
  })

  test("invalid summary query is rejected before route execution", async () => {
    const response = await Server.App().request("/global/performance/summary?windowMs=0")
    expect(response.status).toBe(400)
  })

  test("config route exposes effective observability performance defaults", async () => {
    const response = await Server.App().request("/global/performance/config")
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.config.enabled).toBe(true)
    expect(body.sources).toContain("runtime.observability.performance")
  })
})

process.on("exit", () => {
  PerformanceStore.close()
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})
