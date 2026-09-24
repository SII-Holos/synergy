import { dlopen, ptr, read } from "bun:ffi"

export namespace DarwinCoalition {
  export interface Reference {
    bootID: string
    coalitionID: string
  }
  export type Inspection = { state: "active"; processes: number } | { state: "exited" }
  let native: ReturnType<typeof initialize> | undefined

  function initialize() {
    if (process.platform !== "darwin") throw new Error("Native Darwin process groups are unavailable")
    const system = dlopen("/usr/lib/libSystem.B.dylib", {
      coalition_info_resource_usage: { args: ["u64", "ptr", "u64"], returns: "int" },
      sysctlbyname: { args: ["ptr", "ptr", "ptr", "ptr", "u64"], returns: "int" },
      __error: { args: [], returns: "ptr" },
    })
    let processLibrary: ReturnType<typeof openProcesses> | undefined
    try {
      processLibrary = openProcesses()
      const name = Buffer.from("kern.bootsessionuuid\0"),
        value = Buffer.alloc(128),
        size = new BigUint64Array([128n])
      if (system.symbols.sysctlbyname(ptr(name), ptr(value), ptr(size), null, 0) !== 0)
        throw new Error("Cannot identify the native process boot")
      const bootID = value.toString("utf8").split("\0")[0]!.toLowerCase()
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(bootID))
        throw new Error("Invalid native process boot identity")
      return { system, processLibrary, bootID }
    } catch (error) {
      processLibrary?.close()
      system.close()
      throw error
    }
  }
  function openProcesses() {
    return dlopen("/usr/lib/libproc.dylib", {
      proc_pidinfo: { args: ["int", "int", "u64", "ptr", "int"], returns: "int" },
      proc_listallpids: { args: ["ptr", "int"], returns: "int" },
    })
  }
  function runtime() {
    return (native ??= initialize())
  }
  // Provenance: https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h
  // Local adaptation: coalition membership plus unique process identity survives PID reuse and reparenting.
  function coalition(pid: number) {
    const value = Buffer.alloc(40)
    if (runtime().processLibrary.symbols.proc_pidinfo(pid, 20, 0, ptr(value), value.length) !== value.length) return
    const id = value.readBigUInt64LE(0)
    return id > 0n ? id.toString() : undefined
  }
  function identity(pid: number) {
    const value = Buffer.alloc(56)
    if (runtime().processLibrary.symbols.proc_pidinfo(pid, 17, 0, ptr(value), value.length) !== value.length) return
    return value.readBigUInt64LE(16).toString()
  }
  function validate(reference: Reference) {
    if (!/^[1-9][0-9]*$/.test(reference.coalitionID) || BigInt(reference.coalitionID) > 18446744073709551615n)
      throw new Error("Invalid native process group")
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(reference.bootID))
      throw new Error("Invalid native process group boot")
  }
  export function current(): Reference {
    const coalitionID = coalition(process.pid)
    if (!coalitionID) throw new Error("Cannot identify the native process group")
    return { bootID: runtime().bootID, coalitionID }
  }
  export function capture(pid: number): Reference {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid native process ID")
    const coalitionID = coalition(pid)
    if (!coalitionID) throw new Error("Cannot identify the native process group")
    if (coalitionID === coalition(process.pid)) throw new Error("A process group must be independent of its caller")
    return { bootID: runtime().bootID, coalitionID }
  }
  // Provenance: https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/sys_coalition.c
  // Local adaptation: kernel resource counters establish emptiness even after every observed parent has exited.
  export function inspect(reference: Reference): Inspection {
    validate(reference)
    const host = runtime()
    if (reference.bootID !== host.bootID) return { state: "exited" }
    const value = Buffer.alloc(16)
    const result = host.system.symbols.coalition_info_resource_usage(
      BigInt(reference.coalitionID),
      ptr(value),
      value.length,
    )
    if (result !== 0) {
      const location = host.system.symbols.__error()
      if (location && read.i32(location) === 3) return { state: "exited" }
      throw new Error("Cannot verify native process group liveness")
    }
    const active = value.readBigUInt64LE(0) - value.readBigUInt64LE(8)
    if (active < 0n || active > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Invalid native process group counters")
    return active === 0n ? { state: "exited" } : { state: "active", processes: Number(active) }
  }
  export function terminate(reference: Reference, signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
    validate(reference)
    const host = runtime()
    if (reference.bootID !== host.bootID) return
    if (reference.coalitionID === coalition(process.pid)) throw new Error("Cannot signal the caller's process group")
    signalMembers(reference, signal)
  }
  export function terminateDescendants(signal: "SIGTERM" | "SIGKILL") {
    signalMembers(current(), signal, process.pid)
  }
  function signalMembers(reference: Reference, signal: "SIGTERM" | "SIGKILL", exclude?: number) {
    const host = runtime()
    const list = new Int32Array(65536)
    const count = host.processLibrary.symbols.proc_listallpids(ptr(list), list.byteLength)
    if (count <= 0 || count >= list.length) throw new Error("Cannot enumerate the native process group")
    for (let index = 0; index < count; index++) {
      const pid = list[index]!
      if (pid <= 0 || pid === exclude) continue
      const before = identity(pid)
      if (!before || coalition(pid) !== reference.coalitionID || identity(pid) !== before) continue
      try {
        process.kill(pid, signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
  }
}
