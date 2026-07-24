import { beforeEach, describe, expect, test } from "bun:test"
import { ServiceMemoryMetrics } from "../../src/observability/service-memory-metrics"
import type { ServiceMemory } from "../../src/process/service-memory"

function cgroup(input: { highBytes?: number; maxBytes?: number; oom?: number } = {}): ServiceMemory.CgroupV2 {
  return {
    currentBytes: 1_000,
    peakBytes: 1_200,
    highBytes: input.highBytes ?? 2_000,
    maxBytes: input.maxBytes ?? 3_000,
    swapCurrentBytes: 10,
    stat: {
      anonBytes: 400,
      fileBytes: 300,
      kernelBytes: 100,
      slabBytes: 80,
      activeFileBytes: 120,
      inactiveFileBytes: 180,
      slabReclaimableBytes: 30,
      slabUnreclaimableBytes: 50,
      reclaimableBytes: 210,
      workingSetBytes: 790,
    },
    events: { low: 0, high: 0, max: 0, oom: input.oom ?? 0, oomKill: 0, oomGroupKill: 0 },
    pressure: {
      some: { avg10: 0, avg60: 0, avg300: 0, totalMicros: 100 },
      full: { avg10: 0, avg60: 0, avg300: 0, totalMicros: 10 },
    },
  }
}

describe("ServiceMemoryMetrics", () => {
  beforeEach(() => ServiceMemoryMetrics.resetForTest())

  test("bounds steady cgroup metric rows over one hour", () => {
    const rows = Array.from({ length: 720 }, (_, index) =>
      ServiceMemoryMetrics.plan({ now: index * 5_000, cgroup: cgroup() }),
    ).flat()
    const count = (name: string) => rows.filter((row) => row.name === name).length

    expect(count("service.memory.current")).toBe(720)
    expect(count("service.memory.high")).toBe(12)
    expect(count("service.memory.max")).toBe(12)
    expect(count("service.memory.anon")).toBe(60)
    expect(rows.some((row) => row.name.endsWith(".delta"))).toBe(false)
    expect(rows.length).toBeLessThanOrEqual(2_184)
  })

  test("emits changed limits and positive deltas without waiting for detail sampling", () => {
    ServiceMemoryMetrics.plan({ now: 0, cgroup: cgroup() })
    const changed = ServiceMemoryMetrics.plan({
      now: 5_000,
      cgroup: cgroup({ highBytes: 2_500, oom: 1 }),
    })

    expect(changed).toContainEqual(expect.objectContaining({ name: "service.memory.current", value: 1_000 }))
    expect(changed).toContainEqual(expect.objectContaining({ name: "service.memory.high", value: 2_500 }))
    expect(changed).toContainEqual(expect.objectContaining({ name: "service.memory.events.oom.delta", value: 1 }))
    expect(changed.some((row) => row.name === "service.memory.max")).toBe(false)
    expect(changed.some((row) => row.name === "service.memory.anon")).toBe(false)
  })
})
