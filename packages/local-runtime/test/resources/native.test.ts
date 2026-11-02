import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { cgroupDirectories, linuxResources, memoryFields } from "../../src/resources/linux"
import { nativeResources } from "../../src/resources"

describe("native resource sampling", () => {
  test("resolves namespace-relative cgroup mounts and all visible ancestors", () => {
    const mounts = "1 0 0:1 /tenant /sys/fs/cgroup rw - cgroup2 cgroup rw"
    expect(cgroupDirectories("0::/tenant/child", mounts)).toEqual(["/sys/fs/cgroup/child", "/sys/fs/cgroup"])
    expect(cgroupDirectories("0::/", mounts)).toEqual(["/sys/fs/cgroup"])
    expect(() => cgroupDirectories("0::/other", mounts)).toThrow()
    expect(memoryFields("MemTotal: 1024 kB\nMemAvailable: 512 kB")).toEqual({ MemTotal: 1048576, MemAvailable: 524288 })
  })

  test("uses a parent's remaining hard capacity and treats memory.high only as pressure", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "synergy-resource-probe-"))
    try {
      const proc = path.join(home, "proc")
      const group = path.join(home, "cgroup")
      await mkdir(path.join(proc, "self"), { recursive: true })
      await mkdir(path.join(group, "child"), { recursive: true })
      await writeFile(path.join(proc, "meminfo"), "MemTotal: 1000 kB\nMemAvailable: 800 kB")
      await writeFile(path.join(proc, "self/cgroup"), "0::/child")
      await writeFile(path.join(proc, "self/mountinfo"), `1 0 0:1 / ${group} rw - cgroup2 cgroup rw`)
      for (const [directory, current, max, high] of [
        [group, "900", "1000", "max"],
        [path.join(group, "child"), "100", "max", "50"],
      ]) {
        for (const [name, value] of [
          ["memory.current", current],
          ["memory.max", max],
          ["memory.high", high],
        ]) {
          await writeFile(path.join(directory!, name!), value!)
        }
      }
      const result = await linuxResources(proc).sample()
      expect(result.pressure).toBe("warning")
      expect(result.domains).toContainEqual({ kind: "cgroup", capacityBytes: 1000, availableBytes: 100 })
      expect(result.domains.some((domain) => domain.capacityBytes === 50)).toBe(false)
      await rm(path.join(group, "memory.max"))
      await expect(linuxResources(proc).sample()).rejects.toThrow("unreadable")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("reads the actual host without allocating pressure and closes its native observer", async () => {
    const source = nativeResources()
    let callbacks = 0
    const stop = source.observe?.(() => {
      callbacks++
    })
    try {
      const snapshot = await source.sample()
      expect(snapshot.quality).not.toBe("unavailable")
      expect(snapshot.domains[0]?.kind).toBe("physical")
      expect(snapshot.domains[0]!.capacityBytes).toBeGreaterThan(0)
      expect(snapshot.domains[0]!.availableBytes).toBeLessThanOrEqual(snapshot.domains[0]!.capacityBytes)
      expect(callbacks).toBeGreaterThanOrEqual(0)
    } finally {
      stop?.()
      source.close?.()
    }
  })
})
