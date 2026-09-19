import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
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

  test("applies the strictest ancestor limit along the cgroup chain", () => {
    const root = mkdtempSync(path.join(tmpdir(), "synergy-cgroup-chain-"))
    directories.push(root)
    const child = path.join(root, "session")
    const grandchild = path.join(child, "scope")
    mkdirSync(child)
    mkdirSync(grandchild)
    writeFileSync(path.join(root, "memory.max"), String(8 * 1024 * 1024 * 1024))
    writeFileSync(path.join(child, "memory.max"), String(2 * 1024 * 1024 * 1024))
    writeFileSync(path.join(grandchild, "memory.max"), String(6 * 1024 * 1024 * 1024))

    expect(ServiceMemory.memoryLimitFromDirectories([grandchild, child, root])).toBe(2 * 1024 * 1024 * 1024)
  })

  test("treats a memory.high throttle below memory.max as the effective limit", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "synergy-cgroup-high-"))
    directories.push(directory)
    writeFileSync(path.join(directory, "memory.max"), String(4 * 1024 * 1024 * 1024))
    writeFileSync(path.join(directory, "memory.high"), String(1024 * 1024 * 1024))

    expect(ServiceMemory.memoryLimitFromDirectories([directory])).toBe(1024 * 1024 * 1024)
  })

  test("normalizes the unlimited sentinel and missing or invalid limits", () => {
    const unlimited = mkdtempSync(path.join(tmpdir(), "synergy-cgroup-unlimited-"))
    const partial = mkdtempSync(path.join(tmpdir(), "synergy-cgroup-partial-"))
    const invalid = mkdtempSync(path.join(tmpdir(), "synergy-cgroup-invalid-"))
    directories.push(unlimited, partial, invalid)
    writeFileSync(path.join(unlimited, "memory.max"), "max\n")
    writeFileSync(path.join(unlimited, "memory.high"), "max\n")
    writeFileSync(path.join(partial, "memory.max"), String(3 * 1024 * 1024 * 1024))
    writeFileSync(path.join(partial, "memory.high"), "max\n")
    writeFileSync(path.join(invalid, "memory.max"), "not-a-number\n")
    writeFileSync(path.join(invalid, "memory.high"), "-5\n")

    expect(ServiceMemory.memoryLimitFromDirectories([unlimited])).toBeUndefined()
    expect(ServiceMemory.memoryLimitFromDirectories([partial])).toBe(3 * 1024 * 1024 * 1024)
    expect(ServiceMemory.memoryLimitFromDirectories([invalid])).toBeUndefined()
    expect(ServiceMemory.memoryLimitFromDirectories([unlimited, partial])).toBe(3 * 1024 * 1024 * 1024)
    expect(ServiceMemory.memoryLimitFromDirectories([])).toBeUndefined()
  })

  test("resolves a usable budget and clamps a zero limit to at least one byte", () => {
    const zero = mkdtempSync(path.join(tmpdir(), "synergy-cgroup-zero-"))
    directories.push(zero)
    writeFileSync(path.join(zero, "memory.max"), "0\n")

    expect(ServiceMemory.memoryLimitFromDirectories([zero])).toBe(0)

    const budget = ServiceMemory.resolveMemoryBudget()
    expect(budget.totalBytes).toBeGreaterThan(0)
    expect(budget.limitBytes).toBeGreaterThanOrEqual(1)
    expect(budget.limitBytes).toBeLessThanOrEqual(budget.totalBytes)
    expect(["cgroup_v2", "host"]).toContain(budget.source)
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
