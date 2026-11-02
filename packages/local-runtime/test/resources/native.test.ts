import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { cgroupDirectories, linuxResources, memoryFields } from "../../src/resources/linux"
import { nativeResources } from "../../src/resources"
import { windowsMemoryDomains } from "../../src/resources/windows"
import { ResourceSnapshot } from "@ericsanchezok/synergy-harness/resources/schema"

describe("native resource sampling", () => {
  test("keeps Windows process and system commit headroom separate from plentiful RAM", () => {
    const memory = Buffer.alloc(64)
    const performance = Buffer.alloc(104)
    const application = Buffer.alloc(32)
    memory.writeBigUInt64LE(48n * 1024n ** 3n, 8)
    memory.writeBigUInt64LE(24n * 1024n ** 3n, 16)
    memory.writeBigUInt64LE(150n, 24)
    memory.writeBigUInt64LE(100n, 32)
    performance.writeBigUInt64LE(1000n, 8)
    performance.writeBigUInt64LE(1100n, 16)
    performance.writeBigUInt64LE(4096n, 80)
    application.writeBigUInt64LE(200n, 0)
    const domains = windowsMemoryDomains(memory, performance, application)
    expect(domains).toEqual([
      { kind: "physical", capacityBytes: 48 * 1024 ** 3, availableBytes: 24 * 1024 ** 3 },
      { kind: "process", capacityBytes: 150, availableBytes: 100 },
      { kind: "process", capacityBytes: null, availableBytes: 200 },
      { kind: "commit", capacityBytes: 1100 * 4096, availableBytes: 100 * 4096 },
    ])
  })
  test.skipIf(process.platform !== "win32").each(["job", "process"] as const)(
    "reports incomplete coverage for hidden parent %s limits while observing the immediate Job",
    async (kind) => {
      const ffi = new URL("../../src/native/ffi.ts", import.meta.url).href
      const probe = new URL("../../src/resources/windows.ts", import.meta.url).href
      const script = `
      const { ptr } = await import("bun:ffi")
      const { openNativeLibrary } = await import(${JSON.stringify(ffi)})
      const { windowsResources } = await import(${JSON.stringify(probe)})
      const library = openNativeLibrary("kernel32.dll", {
        CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
        GetCurrentProcess: { args: [], returns: "ptr" },
        SetInformationJobObject: { args: ["ptr", "i32", "ptr", "u32"], returns: "bool" },
        AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "bool" },
        CloseHandle: { args: ["ptr"], returns: "bool" },
      })
      const api = library.symbols
      const jobs = []
      try {
        for (const capacity of [1536, 3072]) {
          const job = api.CreateJobObjectW(null, null)
          if (!job) throw Error("Cannot create test Job")
          jobs.push(job)
          const limits = Buffer.alloc(144)
          limits.writeUInt32LE(${kind === "job" ? 0x200 : 0x100}, 16)
          limits.writeBigUInt64LE(BigInt(capacity * 1024 ** 2), ${kind === "job" ? 120 : 112})
          if (!api.SetInformationJobObject(job, 9, ptr(limits), limits.length) || !api.AssignProcessToJobObject(job, api.GetCurrentProcess())) throw Error("Cannot configure nested test Jobs")
        }
        const source = windowsResources()
        try { console.log(JSON.stringify(await source.sample())) } finally { source.close() }
      } finally { for (const job of jobs.reverse()) api.CloseHandle(job); library.close() }
    `
      const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" })
      try {
        const [output, error, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(code, error).toBe(0)
        const snapshot = ResourceSnapshot.parse(JSON.parse(output))
        expect(snapshot.quality, output).toBe("partial")
        const visible = snapshot.domains.find(
          (domain) => domain.kind === kind && domain.capacityBytes === 3072 * 1024 ** 2,
        )
        expect(visible, output).toBeDefined()
        expect(visible!.availableBytes).toBeGreaterThan(0)
        expect(visible!.availableBytes).toBeLessThan(visible!.capacityBytes!)
      } finally {
        if (child.exitCode === null) child.kill()
        await child.exited
      }
    },
  )
  test("resolves namespace-relative cgroup mounts and all visible ancestors", () => {
    const mounts = "1 0 0:1 /tenant /sys/fs/cgroup rw - cgroup2 cgroup rw"
    expect(cgroupDirectories("0::/tenant/child", mounts)).toEqual(["/sys/fs/cgroup/child", "/sys/fs/cgroup"])
    expect(cgroupDirectories("0::/", mounts)).toEqual(["/sys/fs/cgroup"])
    expect(() => cgroupDirectories("0::/other", mounts)).toThrow()
    expect(memoryFields("MemTotal: 1024 kB\nMemAvailable: 512 kB")).toEqual({ MemTotal: 1048576, MemAvailable: 524288 })
  })

  test.skipIf(process.platform === "win32")(
    "uses a parent's remaining hard capacity and treats memory.high only as pressure",
    async () => {
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
        await writeFile(path.join(group, "memory.stat"), "inactive_file 500\nfile_dirty 50\nfile_writeback 25")
        await writeFile(path.join(group, "memory.events"), "high 0\noom 0\noom_kill 0")
        await writeFile(path.join(group, "memory.pressure"), "full avg10=0.00 total=0")
        expect((await linuxResources(proc).sample()).domains).toContainEqual({
          kind: "cgroup",
          capacityBytes: 1000,
          availableBytes: 100,
          reclaimableBytes: 425,
        })
        await rm(path.join(group, "memory.max"))
        await expect(linuxResources(proc).sample()).rejects.toThrow("unreadable")
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    },
  )

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
      expect(snapshot.domains[0]!.availableBytes).toBeLessThanOrEqual(snapshot.domains[0]!.capacityBytes!)
      expect(callbacks).toBeGreaterThanOrEqual(0)
    } finally {
      stop?.()
      source.close?.()
    }
  })
})
