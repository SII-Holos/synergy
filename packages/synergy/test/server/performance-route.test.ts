import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilitySpans } from "../../src/observability/spans"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { ObservabilityStore } from "../../src/observability/store"
import { Server } from "../../src/server/server"

const homes: string[] = []
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env.SYNERGY_TEST_HOME
  const home = mkdtempSync(path.join(tmpdir(), "synergy-perf-route-"))
  homes.push(home)
  process.env.SYNERGY_TEST_HOME = home
  ObservabilityStore.close()
  ObservabilityConfig.refresh()
})

afterEach(() => {
  process.env.SYNERGY_TEST_HOME = prevHome
})

describe("performance routes", () => {
  test("summary returns dashboard shape without project scope", async () => {
    ObservabilityMetrics.record({
      name: "http.request.duration",
      value: 25,
      unit: "ms",
      module: "server",
      labels: { method: "GET", path: "/global/performance/summary", status: 200 },
    })
    ObservabilityStore.flush()

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

  test("browser metric ingestion drops unsafe context strings", async () => {
    const response = await Server.App().request("/global/performance/browser-metrics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sentAt: Date.now(),
        page: {
          routeName: "prompt raw contract",
          pathTemplate: "/session/:id?token=secret",
          sessionID: "prompt: summarize confidential contract",
          correlationId: "Authorization:BasicSecret",
          navigationId: "nav_safe-1",
        },
        metrics: [
          {
            name: "frontend.token.paint.duration",
            value: 3,
            unit: "ms",
            labels: { sessionID: "sk-live-secret", messageID: "msg_safe-1", component: "ConversationView" },
          },
        ],
      }),
    })

    expect(response.status).toBe(200)
    ObservabilityStore.flush()
    const metrics = ObservabilityStore.queryMetrics({ since: 0, names: ["frontend.token.paint.duration"] })
    expect(metrics).toHaveLength(1)
    expect(metrics[0].session_id).toBeNull()
    expect(metrics[0].correlation_id).not.toBe("Authorization:BasicSecret")
    const labels = JSON.parse(metrics[0].labels_json)
    expect(labels.navigationId).toBe("nav_safe-1")
    expect(labels.messageID).toBe("msg_safe-1")
    expect(labels.component).toBe("ConversationView")
    expect(JSON.stringify(labels)).not.toContain("sk-live-secret")
    const conn = ObservabilityStore.open()!
    const batch = conn
      .prepare("SELECT page_json FROM obs_browser_batches ORDER BY received_time DESC LIMIT 1")
      .get() as {
      page_json: string
    }
    expect(batch.page_json).not.toContain("prompt")
    expect(batch.page_json).not.toContain("Authorization")
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

  test("trace detail includes span kind field", async () => {
    const span = ObservabilitySpans.start({
      name: "llm.stream",
      module: "llm",
      attributes: { model: "test" },
    })!
    const traceId = span.traceId
    ObservabilitySpans.end(span)
    ObservabilityStore.flush()

    const response = await Server.App().request(`/global/performance/traces/${traceId}`)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.spans).toBeArray()
    expect(body.spans.length).toBeGreaterThan(0)
    expect(body.spans[0]).toHaveProperty("kind")
    expect(typeof body.spans[0].kind).toBe("string")
    expect(body.spans[0].kind.length).toBeGreaterThan(0)
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
    const conn = ObservabilityStore.open()
    expect(conn).toBeDefined()
    const insert = conn!.prepare(
      `INSERT INTO obs_metrics (metric_id,time,iso,name,value,unit,source,module,labels_json,sample_rate)
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

    const newest = ObservabilityStore.queryMetrics({
      since: now - 60_000,
      names: ["http.request.duration"],
      limit: 3,
      newestFirst: true,
    })
    expect(newest.map((row) => row.value)).toEqual([50_001, 50_000, 49_999])

    const summary = await Server.App().request("/global/performance/summary?windowMs=86400000")
    expect(summary.status).toBe(200)
    const body = await summary.json()
    expect(body.quality).toMatchObject({ truncated: true, partial: true })
    expect(body.top.slowRoutes.some((item: { label: string }) => item.label === "/route-50001")).toBe(true)
    expect(body.top.slowRoutes.every((item: { label: string }) => item.label !== "/route-0")).toBe(true)
  })

  test("timeline returns chart metrics with aggregation metadata", async () => {
    const now = Date.now()
    ObservabilityMetrics.record({ name: "http.request.duration", value: 10, unit: "ms", module: "server" })
    ObservabilityMetrics.record({ name: "http.request.duration", value: 40, unit: "ms", module: "server" })
    ObservabilityMetrics.record({
      name: "process.cpu.utilization",
      value: 0.2,
      unit: "ratio",
      module: "process",
      source: "process",
    })
    ObservabilityMetrics.record({ name: "session.turn.duration", value: 25, unit: "ms", module: "session" })
    ObservabilityMetrics.record({ name: "storage.operation.count", value: 1, unit: "count", module: "storage" })
    ObservabilityStore.flush()

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
    for (let i = 1; i < pointTimes.length; i++) {
      expect(pointTimes[i - 1]).toBeLessThanOrEqual(pointTimes[i])
    }
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
        page: { routeName: "SessionDetail", pathTemplate: "/session/:id?token=secret" },
        metrics: [],
        resourceEntries: [{ name: "/global/session?token=secret", startTime: 1, duration: 80 }],
        longTasks: [{ startTime: 2, duration: 120, attribution: "script" }],
      }),
    })
    expect(response.status).toBe(200)
    ObservabilityStore.flush()

    const summary = await Server.App().request("/global/performance/summary?windowMs=60000")
    expect(summary.status).toBe(200)
    const body = await summary.json()
    expect(body.top.slowFrontend.some((item: { label: string }) => item.label === "SessionDetail")).toBe(true)
    expect(body.top.slowFrontend.every((item: { label: string }) => !item.label.includes("token"))).toBe(true)
  })

  test("timeline filters by providerID and returns ascending nullable buckets", async () => {
    const now = Date.now()
    ObservabilityMetrics.record({
      name: "llm.request.duration",
      value: 10,
      unit: "ms",
      module: "llm",
      labels: { providerID: "provider-a" },
    })
    ObservabilityMetrics.record({
      name: "llm.request.duration",
      value: 20,
      unit: "ms",
      module: "llm",
      labels: { providerID: "provider-b" },
    })
    ObservabilityStore.flush()

    const from = new Date(now - 1_000).toISOString()
    const to = new Date(now + 2_000).toISOString()
    const response = await Server.App().request(
      `/global/performance/timeline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&bucketMs=1000&metric=llm.call.duration&providerID=provider-a`,
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    const pointTimes = body.series[0].points.map((point: { time: number }) => point.time)
    for (let i = 1; i < pointTimes.length; i++) {
      expect(pointTimes[i - 1]).toBeLessThanOrEqual(pointTimes[i])
    }
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

  test("inflight route reports running spans", async () => {
    const span = (await import("../../src/observability/spans")).ObservabilitySpans.start({
      name: "tool.execution",
      module: "tool",
      tool: "bash",
      attributes: { phase: "execute" },
    })
    ObservabilityStore.flush()

    const response = await Server.App().request("/global/performance/inflight?limit=10")
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.spans.some((item: { spanId: string }) => item.spanId === span?.spanId)).toBe(true)
  })
})

process.on("exit", () => {
  ObservabilityStore.close()
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})
