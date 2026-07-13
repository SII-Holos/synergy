import fsSync from "fs"
import path from "path"
import { ObservabilityRedaction } from "@/observability/redaction"

export namespace ProcessAttribution {
  export interface ProcessInfo {
    pid: number
    ppid: number
    rssBytes: number
    state?: string
    threads?: number
    command?: string
    wchan?: string
  }

  export interface CgroupMemory {
    path?: string
    currentBytes?: number
    peakBytes?: number
    highBytes?: number
    maxBytes?: number
    swapCurrentBytes?: number
  }

  export interface ProcessSet {
    count: number
    rssBytes: number
    top: ProcessInfo[]
  }

  export interface TreeMemory {
    rootRssBytes: number
    childCount: number
    childRssBytes: number
  }

  export interface Summary {
    rootPid: number
    scannedAt: string
    childCount: number
    childRssBytes: number
    topChildren: ProcessInfo[]
    cgroup: CgroupMemory
    cgroupProcesses?: ProcessSet
  }

  export function collect(rootPid = process.pid, options: { topN?: number; includeDetails?: boolean } = {}): Summary {
    const topN = Math.max(0, Math.min(options.topN ?? 20, 100))
    const processes = readProcesses()
    const descendants = descendantPidsFrom(processes, rootPid)
      .map((pid) => processes.get(pid))
      .filter((item): item is ProcessInfo => Boolean(item))
    const cgroup = readCgroupMemory(rootPid)
    return {
      rootPid,
      scannedAt: new Date().toISOString(),
      childCount: descendants.length,
      childRssBytes: descendants.reduce((sum, item) => sum + item.rssBytes, 0),
      topChildren: summarizeProcesses(descendants, topN, options.includeDetails).top,
      cgroup,
      cgroupProcesses: cgroup.path
        ? summarizePids(readCgroupPids(cgroup.path), processes, topN, options.includeDetails)
        : undefined,
    }
  }

  export function readProcess(pid: number): ProcessInfo | undefined {
    const status = readStatus(pid)
    if (!status) return undefined
    return {
      pid,
      ppid: status.ppid,
      rssBytes: status.rssBytes,
      state: status.state,
      threads: status.threads,
    }
  }

  export function memoryByRoot(rootPids: number[]): Map<number, TreeMemory> {
    const processes = readProcesses()
    return new Map(
      rootPids.map((rootPid) => {
        const descendants = descendantPidsFrom(processes, rootPid)
          .map((pid) => processes.get(pid))
          .filter((item): item is ProcessInfo => Boolean(item))
        return [
          rootPid,
          {
            rootRssBytes: processes.get(rootPid)?.rssBytes ?? 0,
            childCount: descendants.length,
            childRssBytes: descendants.reduce((sum, item) => sum + item.rssBytes, 0),
          },
        ]
      }),
    )
  }

  function readProcesses() {
    const result = new Map<number, ProcessInfo>()
    for (const entry of readDir("/proc")) {
      if (!/^\d+$/.test(entry)) continue
      const pid = Number(entry)
      const info = readProcess(pid)
      if (info) result.set(pid, info)
    }
    return result
  }

  function enrichProcess(info: ProcessInfo): ProcessInfo {
    return {
      ...info,
      command: readCommand(info.pid),
      wchan: readText(`/proc/${info.pid}/wchan`)?.trim(),
    }
  }

  function descendantPidsFrom(processes: Map<number, Pick<ProcessInfo, "pid" | "ppid">>, rootPid: number) {
    const children = new Map<number, number[]>()
    for (const item of processes.values()) {
      const bucket = children.get(item.ppid) ?? []
      bucket.push(item.pid)
      children.set(item.ppid, bucket)
    }
    const result: number[] = []
    const stack = [...(children.get(rootPid) ?? [])]
    const seen = new Set<number>()
    while (stack.length) {
      const pid = stack.pop()!
      if (seen.has(pid)) continue
      seen.add(pid)
      result.push(pid)
      stack.push(...(children.get(pid) ?? []))
    }
    return result
  }

  function summarizePids(
    pids: number[],
    processes: Map<number, ProcessInfo>,
    topN: number,
    includeDetails?: boolean,
  ): ProcessSet {
    return summarizeProcesses(
      pids.map((pid) => processes.get(pid)).filter((item): item is ProcessInfo => Boolean(item)),
      topN,
      includeDetails,
    )
  }

  function summarizeProcesses(processes: ProcessInfo[], topN: number, includeDetails?: boolean): ProcessSet {
    return {
      count: processes.length,
      rssBytes: processes.reduce((sum, item) => sum + item.rssBytes, 0),
      top: [...processes]
        .sort((a, b) => b.rssBytes - a.rssBytes)
        .slice(0, topN)
        .map((item) => (includeDetails ? enrichProcess(item) : item)),
    }
  }

  function readCgroupMemory(pid: number): CgroupMemory {
    const relative = readText(`/proc/${pid}/cgroup`)
      ?.split(/\r?\n/)
      .map((line) => line.split(":"))
      .find((parts) => parts.length >= 3 && (parts[1] === "" || parts[1]?.split(",").includes("memory")))?.[2]
    if (!relative) return {}
    const root = path.join("/sys/fs/cgroup", relative)
    return {
      path: relative,
      currentBytes: readNumberFile(path.join(root, "memory.current")),
      peakBytes: readNumberFile(path.join(root, "memory.peak")),
      highBytes: readLimitFile(path.join(root, "memory.high")),
      maxBytes: readLimitFile(path.join(root, "memory.max")),
      swapCurrentBytes: readNumberFile(path.join(root, "memory.swap.current")),
    }
  }

  function readCgroupPids(relative: string) {
    return (readText(path.join("/sys/fs/cgroup", relative, "cgroup.procs")) ?? "")
      .split(/\s+/)
      .map((item) => Number(item))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  }

  function readStatus(pid: number) {
    const text = readText(`/proc/${pid}/status`)
    if (!text) return undefined
    return parseStatusText(text)
  }

  function parseStatusText(text: string) {
    let ppid = 0
    let rssBytes = 0
    let state: string | undefined
    let threads: number | undefined
    for (const line of text.split(/\r?\n/)) {
      const [key, rawValue] = line.split(":", 2)
      const value = rawValue?.trim()
      if (!key || !value) continue
      if (key === "PPid") ppid = Number(value) || 0
      else if (key === "VmRSS") rssBytes = (Number(value.match(/\d+/)?.[0]) || 0) * 1024
      else if (key === "State") state = value
      else if (key === "Threads") threads = Number(value) || undefined
    }
    return { ppid, rssBytes, state, threads }
  }

  function readCommand(pid: number) {
    const cmdline = readBuffer(`/proc/${pid}/cmdline`)
    const text = cmdline?.toString("utf8").replace(/\0/g, " ").trim()
    const fallback = readText(`/proc/${pid}/comm`)?.trim() ?? `pid:${pid}`
    return ObservabilityRedaction.text(text || fallback, 256)
  }

  function readDir(dir: string) {
    try {
      return fsSync.readdirSync(dir)
    } catch {
      return []
    }
  }

  function readText(file: string) {
    try {
      return fsSync.readFileSync(file, "utf8")
    } catch {
      return undefined
    }
  }

  function readBuffer(file: string) {
    try {
      return fsSync.readFileSync(file)
    } catch {
      return undefined
    }
  }

  function readNumberFile(file: string) {
    const text = readText(file)?.trim()
    if (!text) return undefined
    const value = Number(text)
    return Number.isFinite(value) ? value : undefined
  }

  function readLimitFile(file: string) {
    const text = readText(file)?.trim()
    if (!text || text === "max") return undefined
    const value = Number(text)
    return Number.isFinite(value) ? value : undefined
  }

  export const __test = {
    descendantPidsFrom,
    parseStatusText,
    summarizePids,
  }
}
