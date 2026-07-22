import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CortexConcurrency } from "../../src/cortex/concurrency"
import { Server } from "../../src/server/server"

const originalGlobalConcurrency = process.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY

beforeEach(() => {
  delete process.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY
  CortexConcurrency.reset()
})

afterEach(() => {
  if (originalGlobalConcurrency === undefined) delete process.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY
  else process.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY = originalGlobalConcurrency
  CortexConcurrency.reset()
})

function memorySnapshot(rssGiB: number, arrayBuffersGiB = 0) {
  return {
    rssBytes: rssGiB * 1024 ** 3,
    heapUsedBytes: 1,
    heapTotalBytes: 1,
    externalBytes: 1,
    arrayBuffersBytes: arrayBuffersGiB * 1024 ** 3,
  }
}

describe("Cortex routes", () => {
  test("returns configured, effective, and memory-pressure concurrency status", async () => {
    const response = await Server.App().request("/cortex/tasks/concurrency")

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      configured: null,
      environment: null,
      effective: 8,
      memoryPressureLimit: null,
      memoryPressureReason: "normal",
      source: "default",
      perAgentLimit: 8,
      running: 0,
      queued: 0,
    })
  })

  test("reads the active scheduler state without reconfiguring it", async () => {
    CortexConcurrency.configure(3)

    const response = await Server.App().request("/cortex/tasks/concurrency")

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ configured: 3, effective: 3, source: "config" })
    expect(CortexConcurrency.globalStatus()).toMatchObject({ configured: 3, effective: 3, source: "config" })
  })

  test("reports memory pressure as advisory without changing the effective limit", async () => {
    CortexConcurrency.configure(3)
    CortexConcurrency.setMemoryProbeForTest(() => memorySnapshot(10, 9))

    const response = await Server.App().request("/cortex/tasks/concurrency")

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      configured: 3,
      effective: 3,
      memoryPressureLimit: 2,
      memoryPressureReason: "critical_memory_pressure",
      source: "config",
    })
  })
})
