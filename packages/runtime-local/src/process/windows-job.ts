import { dlopen, ptr, type Pointer } from "bun:ffi"
import { spawn } from "node:child_process"
import { once } from "node:events"

export namespace WindowsJob {
  export interface Reference {
    name: string
  }
  export type Inspection = { state: "active"; processes: number } | { state: "exited" }
  const QUERY = 0x0004
  const TERMINATE = 0x0008
  const PROCESS_QUERY = 0x1000
  let native: ReturnType<typeof initialize> | undefined

  function initialize() {
    if (process.platform !== "win32") throw new Error("Windows process jobs are unavailable")
    return dlopen("kernel32.dll", {
      CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
      OpenJobObjectW: { args: ["u32", "bool", "ptr"], returns: "ptr" },
      SetInformationJobObject: { args: ["ptr", "i32", "ptr", "u32"], returns: "bool" },
      QueryInformationJobObject: { args: ["ptr", "i32", "ptr", "u32", "ptr"], returns: "bool" },
      AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "bool" },
      IsProcessInJob: { args: ["ptr", "ptr", "ptr"], returns: "bool" },
      TerminateJobObject: { args: ["ptr", "u32"], returns: "bool" },
      OpenProcess: { args: ["u32", "bool", "u32"], returns: "ptr" },
      GetProcessTimes: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "bool" },
      TerminateProcess: { args: ["ptr", "u32"], returns: "bool" },
      CloseHandle: { args: ["ptr"], returns: "bool" },
      GetLastError: { args: [], returns: "u32" },
    }).symbols
  }
  const runtime = () => (native ??= initialize())
  const error = (operation: string) => new Error(`${operation} failed: ${runtime().GetLastError()}`)
  const wide = (value: string) => Buffer.from(`${value}\0`, "utf16le")
  function close(handle: Pointer) {
    if (!runtime().CloseHandle(handle)) throw error("CloseHandle")
  }
  function open(reference: Reference, access: number) {
    if (!/^Global\\Synergy\.Process\.[1-9][0-9]*\.[a-f0-9]{16}$/.test(reference.name))
      throw new Error("Invalid native Windows job identity")
    const name = wide(reference.name)
    const handle = runtime().OpenJobObjectW(access, false, ptr(name))
    if (handle) return handle
    if (runtime().GetLastError() === 2) return undefined
    throw error("OpenJobObjectW")
  }
  function referenceFor(pid: number): Reference {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid native process ID")
    const host = runtime()
    const child = host.OpenProcess(PROCESS_QUERY, false, pid)
    if (!child) throw error("OpenProcess")
    try {
      const times = Buffer.alloc(32)
      if (!host.GetProcessTimes(child, ptr(times, 0), ptr(times, 8), ptr(times, 16), ptr(times, 24)))
        throw error("GetProcessTimes")
      return { name: `Global\\Synergy.Process.${pid}.${times.readBigUInt64LE(0).toString(16).padStart(16, "0")}` }
    } finally {
      close(child)
    }
  }
  export function capture(pid: number): Reference {
    const reference = referenceFor(pid)
    const job = open(reference, QUERY)
    if (!job) throw new Error("Native Windows job has not been attached")
    const child = runtime().OpenProcess(PROCESS_QUERY, false, pid)
    try {
      if (!child) throw error("OpenProcess")
      const member = new Uint32Array(1)
      if (!runtime().IsProcessInJob(child, job, ptr(member)) || member[0] !== 1)
        throw new Error("Native Windows process is outside its job")
      return reference
    } finally {
      if (child) close(child)
      close(job)
    }
  }
  // Provenance: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
  // Kernel ActiveProcesses, not a process-list snapshot, establishes completion of inherited descendants.
  export function inspect(reference: Reference): Inspection {
    const job = open(reference, QUERY)
    if (!job) return { state: "exited" }
    try {
      const information = Buffer.alloc(48)
      if (!runtime().QueryInformationJobObject(job, 1, ptr(information), information.length, null))
        throw error("QueryInformationJobObject")
      const processes = information.readUInt32LE(40)
      return processes === 0 ? { state: "exited" } : { state: "active", processes }
    } finally {
      close(job)
    }
  }
  export function terminate(reference: Reference) {
    const job = open(reference, TERMINATE)
    if (!job) return
    try {
      if (!runtime().TerminateJobObject(job, 1)) throw error("TerminateJobObject")
    } finally {
      close(job)
    }
  }
  export function terminateDescendants(reference: Reference) {
    const host = runtime()
    const job = open(reference, QUERY)
    if (!job) return
    try {
      const list = Buffer.alloc(8 + 65536 * 8)
      if (!host.QueryInformationJobObject(job, 3, ptr(list), list.length, null))
        throw error("QueryInformationJobObject")
      const count = list.readUInt32LE(4)
      if (count > 65536) throw new Error("Native Windows job exceeds its process bound")
      for (let i = 0; i < count; i++) {
        const pid = Number(list.readBigUInt64LE(8 + i * 8))
        if (pid === process.pid) continue
        const child = host.OpenProcess(PROCESS_QUERY | 1, false, pid)
        if (!child) {
          if (host.GetLastError() === 87) continue
          throw error("OpenProcess")
        }
        try {
          const member = new Uint32Array(1)
          if (!host.IsProcessInJob(child, job, ptr(member))) throw error("IsProcessInJob")
          if (member[0] === 1 && !host.TerminateProcess(child, 1) && host.GetLastError() !== 5)
            throw error("TerminateProcess")
        } finally {
          close(child)
        }
      }
    } finally {
      close(job)
    }
  }
  export async function start(command: string[], directory: string) {
    const child = spawn(command[0]!, command.slice(1), { cwd: directory, stdio: "ignore", windowsHide: true })
    let job: Pointer | undefined
    try {
      await once(child, "spawn")
      const reference = referenceFor(child.pid!)
      const host = runtime()
      const name = wide(reference.name)
      const created = host.CreateJobObjectW(null, ptr(name))
      if (!created) throw error("CreateJobObjectW")
      if (host.GetLastError() === 183) {
        close(created)
        throw new Error("Native Windows job identity already exists")
      }
      job = created
      const limits = Buffer.alloc(144)
      limits.writeUInt32LE(0x2000, 16)
      if (!host.SetInformationJobObject(job, 9, ptr(limits), limits.length)) throw error("SetInformationJobObject")
      const handle = host.OpenProcess(0x0101, false, child.pid!)
      if (!handle) throw error("OpenProcess")
      try {
        if (!host.AssignProcessToJobObject(job, handle)) throw error("AssignProcessToJobObject")
      } finally {
        close(handle)
      }
      return {
        async remove() {
          if (!job) return
          const handle = job
          close(handle)
          job = undefined
        },
      }
    } catch (failure) {
      if (job) close(job)
      child.kill()
      throw failure
    }
  }
}
