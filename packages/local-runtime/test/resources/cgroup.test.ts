import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { CgroupMemory } from "../../src/resources/cgroup"
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
describe("native cgroup details", () => {
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

    expect(await CgroupMemory.readCgroupV2(directory)).toEqual({
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
})
