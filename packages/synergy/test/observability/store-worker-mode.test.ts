import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityMetrics } from "../../src/observability/metrics"
import { ObservabilityStore } from "../../src/observability/store"
import { ObservabilityTelemetryClient } from "../../src/observability/telemetry-client"

const homes: string[] = []
const originalTestHome = process.env.SYNERGY_TEST_HOME
const originalInline = process.env.SYNERGY_OBSERVABILITY_INLINE

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(intervalMs)
  }
  expect(predicate()).toBe(true)
}

describe("ObservabilityStore worker mode", () => {
  beforeEach(() => {
    const home = mkdtempSync(path.join(tmpdir(), "synergy-obs-store-worker-"))
    homes.push(home)
    process.env.SYNERGY_TEST_HOME = home
    mkdirSync(path.join(home, ".synergy", "state"), { recursive: true })
    // Worker mode: SYNERGY_OBSERVABILITY_INLINE must be unset.
    delete process.env.SYNERGY_OBSERVABILITY_INLINE
    ObservabilityStore.close()
    ObservabilityConfig.refresh()
  })

  afterEach(async () => {
    ObservabilityStore.close()
    await ObservabilityTelemetryClient.stop()
    if (originalTestHome === undefined) delete process.env.SYNERGY_TEST_HOME
    else process.env.SYNERGY_TEST_HOME = originalTestHome
    if (originalInline === undefined) delete process.env.SYNERGY_OBSERVABILITY_INLINE
    else process.env.SYNERGY_OBSERVABILITY_INLINE = originalInline
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  test("records metrics through the worker subprocess and reads them via the readonly connection", async () => {
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
  })

  test("stats reports available while the worker runs", async () => {
    const stats = ObservabilityStore.stats()
    expect(stats.available).toBe(false)
    ObservabilityStore.open()
    await waitFor(() => ObservabilityStore.stats().available === true, 15_000)
    await waitFor(() => ObservabilityTelemetryClient.stats().workerReady === true, 15_000)
    expect(ObservabilityStore.stats().pending).toBeGreaterThanOrEqual(0)
    expect(ObservabilityStore.stats().checkpointIntervalMs).toBe(60_000)
  })

  test("close stops the worker", async () => {
    ObservabilityStore.open()
    await waitFor(() => ObservabilityTelemetryClient.stats().workerReady, 15_000)
    ObservabilityStore.close()
    await waitFor(() => ObservabilityTelemetryClient.stats().workerReady === false, 10_000)
  })
})
