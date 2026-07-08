import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { PerformanceConfig } from "../../src/performance/config"
import { PerformanceStore } from "../../src/performance/store"
import { Storage } from "../../src/storage/storage"

const homes: string[] = []
const originalTestHome = process.env.SYNERGY_TEST_HOME

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "synergy-storage-sampling-"))
  homes.push(home)
  process.env.SYNERGY_TEST_HOME = home
  PerformanceStore.close()
  PerformanceConfig.refresh()
})

afterEach(() => {
  PerformanceStore.close()
  PerformanceConfig.refresh()
  if (originalTestHome === undefined) delete process.env.SYNERGY_TEST_HOME
  else process.env.SYNERGY_TEST_HOME = originalTestHome
})

describe.serial("storage telemetry sampling", () => {
  test("samples successful storage durations while preserving counters and errors", async () => {
    const originalRandom = Math.random
    Math.random = () => 0.99
    try {
      await Storage.write(["perf", "sampled"], { count: 1 })
      await expect(Storage.read(["perf", "missing-duration-sample"])).rejects.toThrow()
      PerformanceStore.flush()
    } finally {
      Math.random = originalRandom
    }

    const durationRows = PerformanceStore.queryMetrics({ since: 0, names: ["storage.operation.duration"] })
    const durationStatuses = new Set(durationRows.map((row) => JSON.parse(row.labels_json).status))
    expect(durationStatuses).not.toContain("ok")
    expect(durationStatuses).toContain("error")

    const countRows = PerformanceStore.queryMetrics({ since: 0, names: ["storage.operation.count"] })
    const countStatuses = new Set(countRows.map((row) => JSON.parse(row.labels_json).status))
    expect(countStatuses).toContain("ok")
    expect(countStatuses).toContain("error")
  })
})

process.on("exit", () => {
  PerformanceStore.close()
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})
