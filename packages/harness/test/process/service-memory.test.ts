import { describe, expect, test } from "bun:test"
import { ProcessMemory } from "../../src/process/memory-usage"
import { ServiceMemory } from "../../src/process/service-memory"

describe("ServiceMemory", () => {
  test("prefers cgroup charge and describes process-sum fallback coverage", () => {
    const children = [{ rssBytes: 40 }, { rssBytes: 60 }, { rssBytes: undefined }]

    expect(ServiceMemory.measure({ processRssBytes: 100, children, cgroup: { currentBytes: 500 } })).toEqual({
      currentBytes: 500,
      source: "cgroup_v2",
      coverage: "cgroup",
      complete: true,
      childProcessCount: 3,
      measuredChildProcessCount: 2,
      childProcessRssBytes: 100,
    })
    expect(ServiceMemory.measure({ processRssBytes: 100, children })).toEqual({
      currentBytes: 200,
      source: "process_sum",
      coverage: "registered_processes",
      complete: false,
      childProcessCount: 3,
      measuredChildProcessCount: 2,
      childProcessRssBytes: 100,
    })
  })
})

describe("ProcessMemory", () => {
  test("does not report Bun heap pressure from incompatible accounting sources", () => {
    expect(
      ProcessMemory.heapUsageRatio(
        { heapUsedBytes: 34_000_000, heapTotalBytes: 620_000 },
        { runtime: "bun", version: "1.3.14" },
      ),
    ).toEqual({ available: false, reason: "runtime_accounting_unstable" })
  })

  test("reports a ratio only when the runtime invariant is trustworthy", () => {
    expect(
      ProcessMemory.heapUsageRatio({ heapUsedBytes: 40, heapTotalBytes: 100 }, { runtime: "node", version: "22.0.0" }),
    ).toEqual({ available: true, ratio: 0.4 })
    expect(
      ProcessMemory.heapUsageRatio({ heapUsedBytes: 120, heapTotalBytes: 100 }, { runtime: "node", version: "22.0.0" }),
    ).toEqual({ available: false, reason: "invariant_violated" })
  })
})
