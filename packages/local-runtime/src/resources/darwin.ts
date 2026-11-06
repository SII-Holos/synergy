import { ptr } from "bun:ffi"
import { totalmem } from "node:os"
import { openNativeLibrary } from "../native/ffi"
import type { ResourceHost } from "@ericsanchezok/synergy-harness/resources/host"
import type { ResourceSnapshot } from "@ericsanchezok/synergy-harness/resources/schema"

export function darwinResources(): ResourceHost.Source {
  const library = openNativeLibrary("/usr/lib/libSystem.B.dylib", {
    mach_host_self: { args: [], returns: "u32" },
    mach_port_deallocate: { args: ["u32", "u32"], returns: "i32" },
    mach_task_self: { args: [], returns: "u32" },
    host_page_size: { args: ["u32", "ptr"], returns: "i32" },
    host_statistics64: { args: ["u32", "i32", "ptr", "ptr"], returns: "i32" },
    sysctlbyname: { args: ["ptr", "ptr", "ptr", "ptr", "u64"], returns: "i32" },
    kqueue: { args: [], returns: "i32" },
    kevent64: { args: ["i32", "ptr", "i32", "ptr", "i32", "u32", "ptr"], returns: "i32" },
    close: { args: ["i32"], returns: "i32" },
  })
  const api = library.symbols
  const host = api.mach_host_self()
  const page = new Uint32Array(1)
  if (api.host_page_size(host, ptr(page)) !== 0) {
    api.mach_port_deallocate(api.mach_task_self(), host)
    library.close()
    throw new Error("Cannot read native page size")
  }
  const pressureName = Buffer.from("kern.memorystatus_vm_pressure_level\0")
  let stopObservation: (() => void) | undefined
  let pressure: ResourceSnapshot["pressure"] = "normal"
  return {
    async sample() {
      const stats = Buffer.alloc(512)
      const count = new Uint32Array([stats.length / 4])
      if (api.host_statistics64(host, 4, ptr(stats), ptr(count)) !== 0)
        throw new Error("Cannot read native memory counters")
      const level = new Uint32Array(1)
      const size = new BigUint64Array([4n])
      const measured = api.sysctlbyname(ptr(pressureName), ptr(level), ptr(size), null, 0) === 0
      if (measured) pressure = level[0]! & 4 ? "critical" : level[0]! & 2 ? "warning" : "normal"
      const capacityBytes = totalmem()
      // Provenance: https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/vm_statistics.h
      // Local adaptation: free includes speculative pages; inactive pages are reclaimable, never added twice.
      const availableBytes = Math.min(capacityBytes, (stats.readUInt32LE(0) + stats.readUInt32LE(8)) * page[0]!)
      return {
        sampledAt: Date.now(),
        quality: measured ? "complete" : "partial",
        pressure,
        domains: [{ kind: "physical", capacityBytes, availableBytes }],
        processRssBytes: process.memoryUsage.rss(),
      }
    },
    observe(changed) {
      const queue = api.kqueue()
      if (queue < 0) return () => {}
      const change = Buffer.alloc(48)
      change.writeInt16LE(-12, 8)
      change.writeUInt16LE(1 | 4 | 32, 10)
      change.writeUInt32LE(1 | 2 | 4, 12)
      const timeout = Buffer.alloc(16)
      if (api.kevent64(queue, ptr(change), 1, null, 0, 0, ptr(timeout)) < 0) {
        api.close(queue)
        return () => {}
      }
      const event = Buffer.alloc(48)
      // Poll only the nonblocking native notification queue, not a shell or a fresh memory scan.
      const timer = setInterval(() => {
        if (api.kevent64(queue, null, 0, ptr(event), 1, 0, ptr(timeout)) <= 0) return
        const flags = event.readUInt32LE(12)
        pressure = flags & 4 ? "critical" : flags & 2 ? "warning" : "normal"
        changed()
      }, 250)
      timer.unref()
      let closed = false
      stopObservation = () => {
        if (closed) return
        closed = true
        clearInterval(timer)
        api.close(queue)
      }
      return stopObservation
    },
    close() {
      stopObservation?.()
      api.mach_port_deallocate(api.mach_task_self(), host)
      library.close()
    },
  }
}
