import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ObservabilityConfig } from "../../src/observability/config"
import { ObservabilityContext } from "../../src/observability/context"
import { ObservabilityStore } from "../../src/observability/store"
import { Storage } from "../../src/storage/storage"
import { cleanupObservabilityHomes, resetObservabilityHome } from "../observability/fixture"

beforeEach(() => {
  resetObservabilityHome("synergy-storage-sampling-")
  ObservabilityStore.open()
})

afterEach(() => {
  cleanupObservabilityHomes()
})

describe.serial("storage telemetry sampling", () => {
  test("samples successful storage durations while preserving counters and errors", async () => {
    const correlationId = "storage-sampling-test"
    const originalRandom = Math.random
    Math.random = () => 0.99
    try {
      await ObservabilityContext.withContextAsync({ correlationId }, async () => {
        await Storage.write(["perf", "sampled"], { count: 1 })
        await expect(Storage.read(["perf", "missing-duration-sample"])).rejects.toThrow()
        ObservabilityStore.flush()
      })
    } finally {
      Math.random = originalRandom
    }

    const durationRows = ObservabilityStore.queryMetrics({
      since: 0,
      names: ["storage.operation.duration"],
      correlationId,
    })
    const durationStatuses = new Set(durationRows.map((row) => JSON.parse(row.labels_json).status))
    expect(durationStatuses).not.toContain("ok")
    expect(durationStatuses).toContain("error")

    const countRows = ObservabilityStore.queryMetrics({
      since: 0,
      names: ["storage.operation.count"],
      correlationId,
    })
    const countStatuses = new Set(countRows.map((row) => JSON.parse(row.labels_json).status))
    expect(countStatuses).toContain("ok")
    expect(countStatuses).toContain("error")
  })
})
