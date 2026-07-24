import { beforeEach, describe, expect, test } from "bun:test"
import { LinuxRuntimeMemory } from "../../src/observability/linux-runtime-memory"

function stats(input: { arrays: number; strings: number; heapSize?: number }) {
  return {
    heapSize: input.heapSize ?? 1_000,
    heapCapacity: 2_000,
    extraMemorySize: 300,
    objectCount: input.arrays + input.strings,
    protectedObjectCount: 4,
    objectTypeCounts: { Array: input.arrays, String: input.strings },
    mimalloc: {
      process: { rss_current: 4_000 },
      committed: { current: 3_000 },
      reserved: { current: 5_000 },
      pages_abandoned: { current: 2 },
    },
  }
}

describe("LinuxRuntimeMemory", () => {
  beforeEach(() => LinuxRuntimeMemory.resetForTest())

  test("does not read runtime heap statistics on non-Linux platforms", () => {
    let reads = 0
    const sample = LinuxRuntimeMemory.sample({
      platform: "darwin",
      readStats: () => {
        reads++
        return stats({ arrays: 1, strings: 1 })
      },
    })

    expect(sample).toBeUndefined()
    expect(reads).toBe(0)
  })

  test("caches Linux samples and reports object-type growth", () => {
    let reads = 0
    const readStats = () => {
      reads++
      return reads === 1 ? stats({ arrays: 10, strings: 5 }) : stats({ arrays: 13, strings: 4, heapSize: 1_200 })
    }

    const first = LinuxRuntimeMemory.sample({ platform: "linux", now: 1_000, readStats })
    const cached = LinuxRuntimeMemory.sample({ platform: "linux", now: 30_000, readStats })
    const second = LinuxRuntimeMemory.sample({ platform: "linux", now: 61_001, readStats })

    expect(reads).toBe(2)
    expect(cached).toBe(first)
    expect(first).toMatchObject({
      jscHeapSizeBytes: 1_000,
      jscExtraMemoryBytes: 300,
      allocatorCommittedBytes: 3_000,
      allocatorReservedBytes: 5_000,
    })
    expect(second?.growingObjectTypes).toContainEqual({ type: "Array", count: 13, delta: 3 })
    expect(second?.growingObjectTypes.some((item) => item.type === "String")).toBe(false)
  })
})
