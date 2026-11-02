import { ptr } from "bun:ffi"
import { openNativeLibrary } from "../native/ffi"
import type { ResourceHost } from "@ericsanchezok/synergy-harness/resources/host"
import type { ResourceSnapshot } from "@ericsanchezok/synergy-harness/resources/schema"

const bytes = (buffer: Buffer, offset: number) => Number(buffer.readBigUInt64LE(offset))

export function windowsMemoryDomains(
  memory: Buffer,
  performance: Buffer,
  application: Buffer,
  job?: Buffer,
): ResourceSnapshot["domains"] {
  const page = bytes(performance, 80)
  // Provenance: https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ne-processthreadsapi-process_information_class
  // ProcessAppMemoryInfo reports additional commit availability, not a hard commit limit.
  const domains: ResourceSnapshot["domains"] = [
    { kind: "physical", capacityBytes: bytes(memory, 8), availableBytes: bytes(memory, 16) },
    // Provenance: https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/ns-sysinfoapi-memorystatusex
    // Effective process commit availability is distinct from the immediate Job's accounting.
    { kind: "process", capacityBytes: bytes(memory, 24), availableBytes: bytes(memory, 32) },
    { kind: "process", capacityBytes: null, availableBytes: bytes(application, 0) },
    {
      kind: "commit",
      capacityBytes: bytes(performance, 16) * page,
      availableBytes: Math.max(0, bytes(performance, 16) - bytes(performance, 8)) * page,
    },
  ]
  if (job) {
    // Provenance: https://github.com/winsiderss/phnt/blob/master/ntpsapi.h (PROCESS_JOB_MEMORY_INFO)
    // Private and total commit have separate limits and current usage counters.
    for (const [kind, offset, usage] of [
      ["process", 24, bytes(job, 8)],
      ["job", 32, bytes(job, 0) + bytes(job, 8)],
    ] as const) {
      const capacityBytes = bytes(job, offset)
      if (capacityBytes > 0 && capacityBytes < Number.MAX_SAFE_INTEGER)
        domains.push({ kind, capacityBytes, availableBytes: Math.max(0, capacityBytes - usage) })
    }
  }
  return domains
}

export function windowsResources(): ResourceHost.Source {
  const kernel = openNativeLibrary("kernel32.dll", {
    GlobalMemoryStatusEx: { args: ["ptr"], returns: "bool" },
    GetCurrentProcess: { args: [], returns: "ptr" },
    GetProcessInformation: { args: ["ptr", "i32", "ptr", "u32"], returns: "bool" },
    IsProcessInJob: { args: ["ptr", "ptr", "ptr"], returns: "bool" },
    QueryInformationJobObject: { args: ["ptr", "i32", "ptr", "u32", "ptr"], returns: "bool" },
    CreateMemoryResourceNotification: { args: ["i32"], returns: "ptr" },
    QueryMemoryResourceNotification: { args: ["ptr", "ptr"], returns: "bool" },
    CloseHandle: { args: ["ptr"], returns: "bool" },
  })
  const processLibrary = (() => {
    try {
      return openNativeLibrary("psapi.dll", {
        GetPerformanceInfo: { args: ["ptr", "u32"], returns: "bool" },
        GetProcessMemoryInfo: { args: ["ptr", "ptr", "u32"], returns: "bool" },
      })
    } catch (error) {
      kernel.close()
      throw error
    }
  })()
  const api = kernel.symbols
  const openJobLibrary = () =>
    openNativeLibrary("ntdll.dll", {
      NtQueryInformationProcess: { args: ["ptr", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    })
  let jobLibrary: ReturnType<typeof openJobLibrary> | undefined
  const low = api.CreateMemoryResourceNotification(0)
  const high = api.CreateMemoryResourceNotification(1)
  let pressure: ResourceSnapshot["pressure"] = "normal"
  let timer: ReturnType<typeof setInterval> | undefined
  function readPressure() {
    const flag = new Uint32Array(1)
    if (low && api.QueryMemoryResourceNotification(low, ptr(flag)) && flag[0]) pressure = "critical"
    else if (high && api.QueryMemoryResourceNotification(high, ptr(flag)) && flag[0]) pressure = "normal"
    return pressure
  }
  return {
    async sample() {
      const memory = Buffer.alloc(64)
      memory.writeUInt32LE(memory.length, 0)
      const performance = Buffer.alloc(104)
      performance.writeUInt32LE(performance.length, 0)
      if (
        !api.GlobalMemoryStatusEx(ptr(memory)) ||
        !processLibrary.symbols.GetPerformanceInfo(ptr(performance), performance.length)
      )
        throw new Error("Cannot read system memory availability")
      const application = Buffer.alloc(32)
      if (!api.GetProcessInformation(api.GetCurrentProcess(), 2, ptr(application), application.length))
        throw new Error("Cannot read process commit availability")
      const inJob = new Uint32Array(1)
      if (!api.IsProcessInJob(api.GetCurrentProcess(), null, ptr(inJob))) throw new Error("Cannot inspect process job")
      let job: Buffer | undefined
      if (inJob[0]) {
        jobLibrary ??= openJobLibrary()
        job = Buffer.alloc(40)
        const status = jobLibrary.symbols.NtQueryInformationProcess(
          api.GetCurrentProcess(),
          69,
          ptr(job),
          job.length,
          null,
        )
        if (status < 0) throw new Error(`Cannot read native Job commit availability: ${status}`)
      }
      const domains = windowsMemoryDomains(memory, performance, application, job)
      if (inJob[0]) {
        const limits = Buffer.alloc(144)
        if (!api.QueryInformationJobObject(null, 9, ptr(limits), limits.length, null))
          throw new Error("Cannot inspect job limits")
        const flags = limits.readUInt32LE(16)
        if (flags & 0x200) {
          const usage = Buffer.alloc(16)
          // Provenance: https://github.com/microsoft/hcsshim/blob/main/internal/winapi/jobobject.go
          // Local adaptation: query current committed Job memory rather than its lifetime peak.
          if (!api.QueryInformationJobObject(null, 28, ptr(usage), usage.length, null))
            throw new Error("Cannot read constrained job usage")
          const capacityBytes = bytes(limits, 120)
          domains.push({ kind: "job", capacityBytes, availableBytes: Math.max(0, capacityBytes - bytes(usage, 0)) })
        }
        if (flags & 0x100) {
          const usage = Buffer.alloc(80)
          usage.writeUInt32LE(usage.length, 0)
          if (!processLibrary.symbols.GetProcessMemoryInfo(api.GetCurrentProcess(), ptr(usage), usage.length))
            throw new Error("Cannot read constrained process usage")
          const capacityBytes = bytes(limits, 112)
          domains.push({
            kind: "process",
            capacityBytes,
            availableBytes: Math.max(0, capacityBytes - bytes(usage, 72)),
          })
        }
      }
      return {
        sampledAt: Date.now(),
        quality: low && high ? "complete" : "partial",
        pressure: readPressure(),
        domains,
        processRssBytes: process.memoryUsage.rss(),
      }
    },
    observe(changed) {
      timer = setInterval(() => {
        const previous = pressure
        if (readPressure() !== previous) changed()
      }, 250)
      timer.unref()
      return () => clearInterval(timer)
    },
    close() {
      clearInterval(timer)
      if (low) api.CloseHandle(low)
      if (high) api.CloseHandle(high)
      jobLibrary?.close()
      processLibrary.close()
      kernel.close()
    },
  }
}
