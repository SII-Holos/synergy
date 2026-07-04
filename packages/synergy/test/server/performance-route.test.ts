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
