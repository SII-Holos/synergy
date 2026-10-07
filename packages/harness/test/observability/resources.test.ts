import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityResources } from "../../src/observability/resources"
import { ObservabilityStore } from "../../src/observability/store"
import { ProcessRegistry } from "../../src/process/registry"
import { clearObservabilityState, resetObservabilityState } from "./fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

describe("ObservabilityResources", () => {
  beforeEach(() => runtime.run(() => resetObservabilityState()))
  afterEach(() =>
    runtime.run(() => {
      ObservabilityResources.stop()
      clearObservabilityState()
    }),
  )

  test("resetting the observability home stops an existing resource sampler", () =>
    runtime.run(() => {
      ObservabilityResources.start()

      resetObservabilityState()

      expect(ObservabilityResources.stats().running).toBe(false)
    }))

  test("records finite process resource samples and metrics", () =>
    runtime.run(async () => {
      ObservabilityResources.addRead(128)
      ObservabilityResources.addWrite(256)
      await ObservabilityResources.snapshot({ role: "tool", processId: "proc_test", pid: 12345 })
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
    }))

  test("raises supported memory pressure issues without Bun heap false positives", () =>
    runtime.run(async () => {
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

      await ObservabilityResources.snapshot({ role: "server" })
      ObservabilityStore.flush()

      const openIssues = ObservabilityStore.queryIssues({ status: "open", module: "process" })
      expect(openIssues.some((row) => row.code === "PERF_MEMORY_HIGH_RSS")).toBe(true)
      expect(openIssues.some((row) => row.code === "PERF_MEMORY_HIGH_HEAP_RATIO")).toBe(false)
      expect(openIssues.some((row) => row.code === "PERF_EVENT_LOOP_LAG")).toBe(true)
    }))

  test("measures timer lateness before waiting for child RSS", () =>
    runtime.run(async () => {
      const intervalMs = 500
      ObservabilityConfig.refresh({ observability: { performance: { resourceSampleIntervalMs: intervalMs } } })
      using clock = spyOn(Date, "now").mockReturnValue(10_000)
      const proc = ProcessRegistry.create({ command: "delayed RSS" })
      proc.pid = 1234
      const started = Promise.withResolvers<void>()
      const pending = Promise.withResolvers<ProcessRegistry.ProcessInspection>()
      const restore = ProcessRegistry.setProcessInspector(() => {
        started.resolve()
        return pending.promise
      })
      try {
        ObservabilityResources.start()
        clock.mockReturnValue(10_000 + intervalMs + 25)
        const sampling = ObservabilityResources.snapshot({ processId: "delayed-lag" })
        await started.promise
        clock.mockReturnValue(10_000 + intervalMs + 25 + 700)
        pending.resolve({ alive: true, rssBytes: 4096 })
        await sampling
        ObservabilityStore.flush()
        const sample = ObservabilityStore.resourceSince(0).find((row) => row.process_id === "delayed-lag")
        expect(sample?.event_loop_lag_ms).toBe(25)
      } finally {
        pending.resolve({})
        await ObservabilityResources.stop()
        restore()
        ProcessRegistry.remove(proc.id)
      }
    }))

  test("periodic sampling completes 700ms queries at the 500ms interval without superseding them", () =>
    runtime.run(async () => {
      ObservabilityConfig.refresh({ observability: { performance: { resourceSampleIntervalMs: 500 } } })
      const proc = ProcessRegistry.create({ command: "slow periodic RSS" })
      proc.pid = 1234
      const completed = Promise.withResolvers<void>()
      let completedQueries = 0
      let cancelledQueries = 0
      const restore = ProcessRegistry.setProcessInspector(
        (_pid, _proc, signal) =>
          new Promise((resolve) => {
            const abort = () => {
              clearTimeout(timer)
              cancelledQueries++
              resolve({})
            }
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", abort)
              if (++completedQueries === 2) completed.resolve()
              resolve({ alive: true, rssBytes: 4096 })
            }, 700)
            signal.addEventListener("abort", abort, { once: true })
          }),
      )
      const deadline = setTimeout(() => completed.reject(new Error("periodic RSS queries never completed")), 3500)
      try {
        ObservabilityResources.start()
        await completed.promise
        await Bun.sleep(0)
        ObservabilityStore.flush()
        const frames = ObservabilityStore.resourceSince(0).filter((row) => row.process_role === "server")
        expect(frames).toHaveLength(2)
        expect(frames.every((row) => (row.event_loop_lag_ms ?? Infinity) < 250)).toBe(true)
        expect(cancelledQueries).toBe(0)
        expect(ObservabilityResources.stats().sampleIntervalMs).toBe(500)
      } finally {
        clearTimeout(deadline)
        await ObservabilityResources.stop()
        restore()
        ProcessRegistry.remove(proc.id)
      }
    }))

  test("supersedes a pending sample and cancels sampling on stop without storing stale frames", () =>
    runtime.run(async () => {
      const proc = ProcessRegistry.create({ command: "pending sampler" })
      proc.pid = 1234
      const started = Promise.withResolvers<void>()
      const pending = Promise.withResolvers<ProcessRegistry.ProcessInspection>()
      let calls = 0
      let signal: AbortSignal | undefined
      const restore = ProcessRegistry.setProcessInspector((_pid, _proc, querySignal) => {
        if (++calls > 1) return { alive: true, rssBytes: 4096 }
        signal = querySignal
        started.resolve()
        return pending.promise
      })
      try {
        const older = ObservabilityResources.snapshot({ processId: "older" })
        await started.promise
        await ObservabilityResources.snapshot({ processId: "latest" })
        expect(signal?.aborted).toBe(true)
        pending.resolve({ alive: true, rssBytes: 8192 })
        await older
        ObservabilityStore.flush()
        expect(ObservabilityStore.resourceSince(0).some((row) => row.process_id === "older")).toBe(false)
        expect(ObservabilityStore.resourceSince(0).some((row) => row.process_id === "latest")).toBe(true)
        const stopping = Promise.withResolvers<void>()
        const draining = Promise.withResolvers<ProcessRegistry.ProcessInspection>()
        ProcessRegistry.setProcessInspector((_pid, _proc, querySignal) => {
          signal = querySignal
          stopping.resolve()
          return draining.promise
        })
        const stopped = ObservabilityResources.snapshot({ processId: "stopped" })
        await stopping.promise
        let stopCompleted = false
        const cleanup = ObservabilityResources.stop().then(() => {
          stopCompleted = true
        })
        expect(stopCompleted).toBe(false)
        draining.resolve({})
        await Promise.all([stopped, cleanup])
        expect(signal?.aborted).toBe(true)
        ObservabilityStore.flush()
        expect(ObservabilityStore.resourceSince(0).some((row) => row.process_id === "stopped")).toBe(false)
      } finally {
        pending.resolve({})
        restore()
        ProcessRegistry.remove(proc.id)
      }
    }))

  test("reconfigures resource and store maintenance timers without restart", () =>
    runtime.run(() => {
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
    }))
})

afterRuntimeTests(() => runtime.close())
