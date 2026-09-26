import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ObservabilityConfig } from "../../src/observability/config"
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
