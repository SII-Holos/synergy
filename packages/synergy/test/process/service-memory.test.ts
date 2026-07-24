import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { ProcessMemory } from "../../src/process/memory-usage"
import { ServiceMemory } from "../../src/process/service-memory"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("ServiceMemory", () => {
  test("reads cgroup v2 gauges, breakdown, and lifetime counters", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "synergy-cgroup-v2-"))
    directories.push(directory)
    writeFileSync(path.join(directory, "memory.current"), "1000\n")
    writeFileSync(path.join(directory, "memory.high"), "2000\n")
    writeFileSync(path.join(directory, "memory.max"), "max\n")
    writeFileSync(path.join(directory, "memory.peak"), "3000\n")
    writeFileSync(path.join(directory, "memory.swap.current"), "400\n")
    writeFileSync(
      path.join(directory, "memory.stat"),
      [
        "anon 500",
        "file 250",
        "kernel 125",
        "slab 75",
        "active_file 100",
        "inactive_file 80",
        "slab_reclaimable 20",
        "slab_unreclaimable 55",
      ].join("\n"),
    )
    writeFileSync(path.join(directory, "memory.events"), "low 1\nhigh 2\nmax 3\noom 4\noom_kill 5\noom_group_kill 6\n")
    writeFileSync(
      path.join(directory, "memory.pressure"),
      "some avg10=0.10 avg60=0.20 avg300=0.30 total=400\nfull avg10=0.01 avg60=0.02 avg300=0.03 total=40\n",
    )

    expect(await ServiceMemory.readCgroupV2(directory)).toEqual({
      currentBytes: 1000,
      highBytes: 2000,
      peakBytes: 3000,
      swapCurrentBytes: 400,
      stat: {
        anonBytes: 500,
        fileBytes: 250,
        kernelBytes: 125,
        slabBytes: 75,
        activeFileBytes: 100,
        inactiveFileBytes: 80,
        slabReclaimableBytes: 20,
        slabUnreclaimableBytes: 55,
        reclaimableBytes: 100,
        workingSetBytes: 900,
      },
      events: { low: 1, high: 2, max: 3, oom: 4, oomKill: 5, oomGroupKill: 6 },
      pressure: {
        some: { avg10: 0.1, avg60: 0.2, avg300: 0.3, totalMicros: 400 },
        full: { avg10: 0.01, avg60: 0.02, avg300: 0.03, totalMicros: 40 },
      },
    })
  })

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
