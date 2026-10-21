import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityIssues } from "../../src/observability/issues"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { ObservabilityStore } from "../../src/observability/store"
import { ObservabilityTelemetryClient } from "../../src/observability/telemetry-client"
import { testRuntime } from "../support/runtime"
let runtime: Awaited<ReturnType<typeof testRuntime>>

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(intervalMs)
  }
  expect(predicate()).toBe(true)
}

describe("ObservabilityStore worker mode", () => {
  beforeEach(async () => {
    runtime = await testRuntime({ env: { SYNERGY_OBSERVABILITY_INLINE: undefined } })
    await runtime.run(async () => {
      ObservabilityConfig.refresh()
      ObservabilityStore.markRuntimeReady()
      await ObservabilityStore.close()
    })
  })

  afterEach(() => runtime.close())

  test("records metrics through the worker subprocess and reads them via the readonly connection", () =>
    runtime.run(async () => {
      ObservabilityStore.open()
      // Wait for the worker's ready handshake, not just the readonly connection:
      // the sqlite file appears as soon as the worker opens it, but batches only
      // flow once the worker has processed the start message.
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady === true, 15_000)
      expect(ObservabilityStore.stats().available).toBe(true)

      ObservabilityMetrics.record({
        name: "worker.mode.metric",
        value: 42,
        unit: "count",
        module: "observability",
      })
      ObservabilityStore.flush()
      await ObservabilityTelemetryClient.flushAndWait(5000)

      const rows = ObservabilityStore.queryMetrics({ since: 0, names: ["worker.mode.metric"] })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.value).toBe(42)
      expect(rows[0]?.name).toBe("worker.mode.metric")
    }))

  test("stats reports available while the worker runs", () =>
    runtime.run(async () => {
      expect(ObservabilityTelemetryClient.stats().workerReady).toBe(false)
      ObservabilityStore.open()
      await waitFor(() => ObservabilityStore.stats().available === true, 15_000)
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady === true, 15_000)
      expect(ObservabilityStore.stats().pending).toBeGreaterThanOrEqual(0)
      expect(ObservabilityStore.stats().checkpointIntervalMs).toBe(60_000)
    }))

  test("uses the existing worker batch window for exact condition deltas and typed recovery", () =>
    runtime.run(async () => {
      ObservabilityStore.open()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
      using enqueues = spyOn(ObservabilityTelemetryClient, "enqueue")
      const input = {
        owner: "control-plane" as const,
        code: "PERF_TEST_WORKER_CONDITION",
        module: "process" as const,
        title: "Worker condition",
        severity: "warning" as const,
        state: "active" as const,
        observedValue: 120,
        thresholdValue: 100,
        unit: "bytes" as const,
      }
      for (let index = 0; index < 1000; index++)
        ObservabilityIssues.observeCondition({ ...input, observedValue: 120 + index })
      using observer = new Database(ObservabilityStore.pathName(), { readonly: true })
      await waitFor(
        () => observer.query("SELECT issue_id FROM obs_issues WHERE code = ?").get(input.code) !== null,
        5000,
      )
      const [first] = ObservabilityIssues.list({ module: "process" })
      expect(first).toMatchObject({
        occurrenceCount: 1000,
        evidence: { firstObservedValue: 120, observedValue: 1119, peakObservedValue: 1119 },
      })
      expect(enqueues.mock.calls.filter(([row]) => row.kind === "issue")).toHaveLength(1)
      ObservabilityIssues.observeCondition({ ...input, observedValue: 130 })
      ObservabilityIssues.observeCondition({ ...input, state: "normal", observedValue: 20 })
      ObservabilityIssues.observeCondition({ ...input, observedValue: 140 })
      ObservabilityStore.queryIssues()
      await ObservabilityTelemetryClient.flushAndWait()
      expect(ObservabilityIssues.list({ status: "resolved", module: "process" })).toMatchObject([
        { issueId: first.issueId, occurrenceCount: 1001 },
      ])
      expect(ObservabilityIssues.list({ module: "process" })).toMatchObject([
        { occurrenceCount: 1, evidence: { firstObservedValue: 140 } },
      ])
      ObservabilityIssues.observeCondition({ ...input, observedValue: 150 })
      await ObservabilityStore.stop()
      using reader = new Database(ObservabilityStore.pathName(), { readonly: true })
      expect(
        reader.query("SELECT occurrence_count FROM obs_issues WHERE status = 'open' AND code = ?").get(input.code),
      ).toEqual({ occurrence_count: 2 })
    }))

  test("metric aggregation yields to the host and retains numeric bucket results", () =>
    runtime.run(async () => {
      ObservabilityStore.open()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
      for (const value of [10, 20, 30])
        ObservabilityMetrics.record({ name: "reader.metric", value, unit: "ms", module: "observability" })
      await ObservabilityTelemetryClient.flushAndWait()
      const tick = new Promise<string>((resolve) => setTimeout(() => resolve("host"), 0))
      const query = Promise.resolve(
        ObservabilityStore.queryMetricBuckets({ since: 0, names: ["reader.metric"], bucketMs: Date.now() + 1 }),
      )
      expect(await Promise.race([query.then(() => "query"), tick])).toBe("host")
      expect(await query).toEqual([expect.objectContaining({ count: 3, sum: 60, p50: 20, p95: 30, errors: 0 })])
      await ObservabilityStore.close()
      ObservabilityStore.open()
      expect(await ObservabilityStore.queryMetricCounts({ since: 0, names: ["reader.metric"] })).toEqual([
        { name: "reader.metric", module: "observability", count: 3 },
      ])
    }))

  test("close drains the active metric read and rejects queued reads", () =>
    runtime.run(async () => {
      ObservabilityStore.open()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
      const first = ObservabilityStore.queryMetricCounts({ since: 0 })
      const second = ObservabilityStore.queryMetricCounts({ since: 0 })
      const results = Promise.allSettled([first, second])
      await ObservabilityStore.close()
      expect((await results).map((result) => result.status)).toEqual(["fulfilled", "rejected"])
      ObservabilityStore.open()
      expect(await ObservabilityStore.queryMetricCounts({ since: 0 })).toBeArray()
    }))

  test("a stopped store cannot reopen the metric reader", () =>
    runtime.run(async () => {
      ObservabilityStore.open()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
      await ObservabilityStore.stop()
      await expect(ObservabilityStore.queryMetricCounts({ since: 0 })).rejects.toThrow("closed")
    }))

  test("close stops the worker", () =>
    runtime.run(async () => {
      ObservabilityStore.open()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
      await ObservabilityStore.close()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady === false, 10_000)
    }))
  test("re-enabling after close restarts the worker via reconfigure", () =>
    runtime.run(async () => {
      ObservabilityStore.open()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
      await ObservabilityStore.close()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady === false, 10_000)

      // Disable, then re-enable through the config path; reconfigure() must
      // start the worker again instead of buffering a control message forever.
      ObservabilityConfig.refresh({ observability: { enabled: true } })
      ObservabilityStore.reconfigure()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
      expect(ObservabilityStore.stats().available).toBe(true)
    }))

  test("drops telemetry while observability is disabled", () =>
    runtime.run(async () => {
      ObservabilityStore.open()
      await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
      ObservabilityConfig.refresh({ observability: { enabled: false } })
      ObservabilityStore.insertMetric({
        metricId: "disabled_metric",
        time: Date.now(),
        name: "disabled.metric",
        value: 1,
        unit: "count",
        source: "backend",
        module: "observability",
        labels: {},
        sampleRate: 1,
      })
      expect(ObservabilityTelemetryClient.stats().pending).toBe(0)
    }))
})
