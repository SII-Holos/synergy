import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ServiceMemory } from "../../src/observability/service-memory"
import { tmpdir } from "../fixture/fixture"

describe("ServiceMemory", () => {
  test("reads complete cgroup v2 memory and recursive process attribution on Linux", async () => {
    await using tmp = await tmpdir()
    const procRoot = path.join(tmp.path, "proc")
    const cgroupRoot = path.join(tmp.path, "cgroup")
    const serviceDir = path.join(cgroupRoot, "user.slice", "synergy.service")
    const childDir = path.join(serviceDir, "workers")

    await write(path.join(procRoot, "self", "cgroup"), "0::/user.slice/synergy.service\n")
    await write(path.join(serviceDir, "memory.current"), "10000\n")
    await write(path.join(serviceDir, "memory.peak"), "12000\n")
    await write(path.join(serviceDir, "memory.high"), "20000\n")
    await write(path.join(serviceDir, "memory.max"), "30000\n")
    await write(path.join(serviceDir, "memory.swap.current"), "400\n")
    await write(path.join(serviceDir, "memory.stat"), "anon 6000\nfile 3000\nkernel 1000\nslab 700\n")
    await write(path.join(serviceDir, "memory.events"), "low 1\nhigh 2\nmax 3\noom 4\noom_kill 5\n")
    await write(
      path.join(serviceDir, "memory.pressure"),
      "some avg10=1.25 avg60=0.50 avg300=0.10 total=1200\nfull avg10=0.25 avg60=0.10 avg300=0.00 total=300\n",
    )
    await write(path.join(serviceDir, "cgroup.procs"), "100\n101\n")
    await write(path.join(childDir, "cgroup.procs"), "102\n")

    await writeProcess(procRoot, 100, 100, 80, "bun")
    await writeProcess(procRoot, 101, 200, 160, "codex")
    await writeProcess(procRoot, 102, 300, 240, "node")

    const sample = ServiceMemory.sample({
      platform: "linux",
      pid: 100,
      procRoot,
      cgroupRoot,
      processMemory: memoryUsage(999),
      knownProcesses: [{ pid: 102, processId: "process_registered", rssBytes: 1 }],
    })

    expect(sample).toMatchObject({
      source: "cgroup-v2",
      currentBytes: 10000,
      peakBytes: 12000,
      highBytes: 20000,
      maxBytes: 30000,
      usageRatio: 0.5,
      swapBytes: 400,
      anonBytes: 6000,
      fileBytes: 3000,
      kernelBytes: 1000,
      slabBytes: 700,
      processCount: 3,
      rssProcessCount: 3,
      pssProcessCount: 3,
      processRssBytes: 600 * 1024,
      processPssBytes: 480 * 1024,
      events: { low: 1, high: 2, max: 3, oom: 4, oomKill: 5 },
      pressure: {
        some: { avg10Ratio: 0.0125, avg60Ratio: 0.005, avg300Ratio: 0.001, totalMicros: 1200 },
        full: { avg10Ratio: 0.0025, avg60Ratio: 0.001, avg300Ratio: 0, totalMicros: 300 },
      },
    })
    expect(sample.processes).toEqual([
      { pid: 100, role: "main", name: "bun", rssBytes: 100 * 1024, pssBytes: 80 * 1024 },
      { pid: 101, role: "child", name: "codex", rssBytes: 200 * 1024, pssBytes: 160 * 1024 },
      {
        pid: 102,
        role: "child",
        processId: "process_registered",
        name: "node",
        rssBytes: 300 * 1024,
        pssBytes: 240 * 1024,
      },
    ])
  })

  test("falls back to main plus all known child RSS on macOS and Windows", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const sample = ServiceMemory.sample({
        platform,
        pid: 10,
        processMemory: memoryUsage(1000),
        knownProcesses: [
          { pid: 11, processId: "child-1", rssBytes: 200 },
          { pid: 12, processId: "child-2", rssBytes: 300 },
        ],
      })

      expect(sample).toMatchObject({
        source: "process-sum",
        currentBytes: 1500,
        processCount: 3,
        rssProcessCount: 3,
        processRssBytes: 1500,
      })
      expect(sample.processes).toHaveLength(3)
    }
  })

  test("reports counter deltas without treating a cgroup reset as negative pressure", () => {
    const previous = ServiceMemory.sample({ platform: "darwin", pid: 10, processMemory: memoryUsage(1000) })
    const current = {
      ...previous,
      source: "cgroup-v2" as const,
      events: { high: 7, max: 3, oom: 1 },
      pressure: { some: { totalMicros: 1_500 }, full: { totalMicros: 400 } },
    }
    const baseline = {
      ...current,
      events: { high: 5, max: 4, oom: 0 },
      pressure: { some: { totalMicros: 1_000 }, full: { totalMicros: 500 } },
    }

    expect(ServiceMemory.withDeltas(current, baseline)).toMatchObject({
      eventDeltas: { high: 2, max: 3, oom: 1 },
      pressureDelta: { someMicros: 500, fullMicros: 400 },
    })
  })

  test("requests cgroup reclaim only on Linux cgroup v2", async () => {
    await using tmp = await tmpdir()
    const procRoot = path.join(tmp.path, "proc")
    const cgroupRoot = path.join(tmp.path, "cgroup")
    const serviceDir = path.join(cgroupRoot, "user.slice", "synergy.service")
    await write(path.join(procRoot, "self", "cgroup"), "0::/user.slice/synergy.service\n")
    await write(path.join(serviceDir, "memory.current"), "10000\n")
    await write(path.join(serviceDir, "memory.stat"), "anon 6000\ninactive_file 3000\n")
    await write(path.join(serviceDir, "memory.reclaim"), "")
    const result = await ServiceMemory.reclaim(4096, {
      platform: "linux",
      procRoot,
      cgroupRoot,
    })

    expect(result).toEqual({ requestedBytes: 4096, supported: true })
    expect(await Bun.file(path.join(serviceDir, "memory.reclaim")).text()).toBe("4096")
    expect(await ServiceMemory.reclaim(4096, { platform: "darwin" })).toEqual({
      requestedBytes: 4096,
      supported: false,
    })
  })
})

async function write(file: string, value: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, value)
}

async function writeProcess(procRoot: string, pid: number, rssKb: number, pssKb: number, name: string) {
  await write(path.join(procRoot, String(pid), "status"), `Name:\t${name}\nVmRSS:\t${rssKb} kB\n`)
  await write(path.join(procRoot, String(pid), "smaps_rollup"), `Rss: ${rssKb} kB\nPss: ${pssKb} kB\n`)
  await write(path.join(procRoot, String(pid), "comm"), `${name}\n`)
}

function memoryUsage(rss: number): NodeJS.MemoryUsage {
  return { rss, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }
}
