import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityResources } from "../../src/observability/resources"
import { ObservabilityStore } from "../../src/observability/store"
import { cleanupObservabilityHomes, resetObservabilityHome } from "./fixture"

describe("ObservabilityResources", () => {
  beforeEach(() => resetObservabilityHome())
  afterEach(() => {
    ObservabilityResources.stop()
    cleanupObservabilityHomes()
  })

  test("records finite process resource samples and metrics", () => {
    ObservabilityResources.addRead(128)
    ObservabilityResources.addWrite(256)
    ObservabilityResources.snapshot({ role: "tool", processId: "proc_test", pid: 12345 })
    ObservabilityStore.flush()

    const sample = ObservabilityStore.latestResource()
    expect(sample).toBeDefined()
    expect(sample!.process_role).toBe("tool")
    expect(sample!.process_id).toBe("proc_test")
    expect(sample!.pid).toBe(12345)
    expect(Number.isFinite(sample!.cpu_utilization_ratio ?? 0)).toBe(true)
    expect(Number.isFinite(sample!.memory_rss_bytes ?? 0)).toBe(true)
    expect(Number.isFinite(sample!.event_loop_lag_ms ?? 0)).toBe(true)
    expect(sample!.app_read_bytes).toBeGreaterThanOrEqual(128)
    expect(sample!.app_written_bytes).toBeGreaterThanOrEqual(256)

    const metricNames = new Set(ObservabilityStore.queryMetrics({ since: 0 }).map((row) => row.name))
    expect(metricNames).toContain("process.memory.rss")
    expect(metricNames).toContain("process.cpu.utilization")
    expect(metricNames).toContain("process.event_loop.lag")
  })

  test("raises deterministic memory pressure issue when thresholds are exceeded", () => {
    ObservabilityConfig.refresh({
      observability: {
        performance: {
          thresholds: {
            highRssBytes: 1,
            highHeapUsedRatio: 0,
            eventLoopLagMs: 0,
          },
        },
      },
    })

    ObservabilityResources.snapshot({ role: "server" })
    ObservabilityStore.flush()

    const openIssues = ObservabilityStore.queryIssues({ status: "open", module: "process" })
    expect(openIssues.some((row) => row.code === "PERF_MEMORY_HIGH_RSS")).toBe(true)
    expect(openIssues.some((row) => row.code === "PERF_MEMORY_HIGH_HEAP_RATIO")).toBe(true)
    expect(openIssues.some((row) => row.code === "PERF_EVENT_LOOP_LAG")).toBe(true)
  })

  test("reconfigures resource and store maintenance timers without restart", () => {
    ObservabilityStore.open()
    ObservabilityResources.start()
    ObservabilityConfig.refresh({
      observability: {
        performance: {
          metricRetentionMs: 400_000,
          resourceSampleIntervalMs: 777,
          storage: { walCheckpointIntervalMs: 1_234 },
        },
      },
    })

    ObservabilityStore.reconfigure()
    ObservabilityResources.reconfigure()

    expect(ObservabilityStore.stats().checkpointIntervalMs).toBe(1_234)
    expect(ObservabilityStore.stats().retentionIntervalMs).toBe(100_000)
    expect(ObservabilityResources.stats()).toEqual({ running: true, sampleIntervalMs: 777 })
  })
})
