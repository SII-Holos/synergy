import fs from "node:fs"
import path from "node:path"

export namespace ServiceMemory {
  export type Source = "cgroup-v2" | "process-sum" | "unknown"

  export interface KnownProcess {
    pid?: number
    processId?: string
    rssBytes?: number
  }

  export interface ProcessSample {
    pid?: number
    processId?: string
    role: "main" | "child"
    name?: string
    rssBytes?: number
    pssBytes?: number
  }

  export interface Events {
    low?: number
    high?: number
    max?: number
    oom?: number
    oomKill?: number
    oomGroupKill?: number
  }

  export interface Snapshot {
    source: Source
    currentBytes?: number
    peakBytes?: number
    highBytes?: number
    maxBytes?: number
    usageRatio?: number
    swapBytes?: number
    anonBytes?: number
    fileBytes?: number
    kernelBytes?: number
    slabBytes?: number
    processCount: number
    rssProcessCount: number
    pssProcessCount: number
    processRssBytes?: number
    processPssBytes?: number
    events: Events
    processes: ProcessSample[]
  }

  export interface ReadOptions {
    platform?: NodeJS.Platform
    procRoot?: string
    cgroupRoot?: string
  }

  export interface SampleOptions extends ReadOptions {
    pid?: number
    processMemory?: NodeJS.MemoryUsage
    knownProcesses?: KnownProcess[]
  }

  type CgroupSnapshot = Omit<
    Snapshot,
    "source" | "processCount" | "rssProcessCount" | "pssProcessCount" | "processes"
  > & {
    directory: string
  }

  export function readCgroup(options: ReadOptions = {}): Omit<CgroupSnapshot, "directory"> | undefined {
    const result = readLinuxCgroup(options)
    if (!result) return
    const { directory: _, ...snapshot } = result
    return snapshot
  }

  export function sample(options: SampleOptions = {}): Snapshot {
    const platform = options.platform ?? process.platform
    const pid = options.pid ?? process.pid
    const processMemory = options.processMemory ?? process.memoryUsage()
    const knownProcesses = options.knownProcesses ?? []
    const cgroup = readLinuxCgroup(options)

    if (platform === "linux" && cgroup) {
      const pids = cgroupPids(cgroup.directory)
      if (!pids.has(pid)) pids.add(pid)
      const knownByPid = new Map(
        knownProcesses.flatMap((item) => (item.pid === undefined ? [] : ([[item.pid, item]] as const))),
      )
      const processes = [...pids]
        .sort((a, b) => a - b)
        .map((itemPid) => {
          const known = knownByPid.get(itemPid)
          return processSample({
            pid: itemPid,
            mainPid: pid,
            procRoot: options.procRoot,
            processMemory: itemPid === pid ? processMemory : undefined,
            known,
          })
        })
      const sampledPids = new Set(processes.flatMap((item) => (item.pid === undefined ? [] : [item.pid])))
      for (const known of knownProcesses) {
        if (known.pid === undefined || sampledPids.has(known.pid)) continue
        processes.push(
          processSample({
            pid: known.pid,
            mainPid: pid,
            procRoot: options.procRoot,
            known,
          }),
        )
      }
      return finalize({ source: "cgroup-v2", ...cgroup, processes })
    }

    const processes = fallbackProcesses({ pid, processMemory, knownProcesses, procRoot: options.procRoot, platform })
    const result = finalize({ source: processes.length > 0 ? "process-sum" : "unknown", processes, events: {} })
    return { ...result, currentBytes: result.processRssBytes }
  }

  function readLinuxCgroup(options: ReadOptions): CgroupSnapshot | undefined {
    if ((options.platform ?? process.platform) !== "linux") return
    const procRoot = options.procRoot ?? "/proc"
    const cgroupRoot = options.cgroupRoot ?? "/sys/fs/cgroup"
    const membership = readText(path.join(procRoot, "self", "cgroup"))
    if (!membership) return
    const unified = membership
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("0::"))
    if (!unified) return
    const parts = unified.slice(3).split("/").filter(Boolean)
    if (parts.some((part) => part === "." || part === "..")) return
    const directory = path.join(cgroupRoot, ...parts)
    const currentBytes = readNumber(path.join(directory, "memory.current"))
    if (currentBytes === undefined) return

    const highBytes = readNumber(path.join(directory, "memory.high"))
    const maxBytes = readNumber(path.join(directory, "memory.max"))
    const limitBytes = highBytes ?? maxBytes
    const stat = parseKeyValues(readText(path.join(directory, "memory.stat")))
    const events = parseKeyValues(readText(path.join(directory, "memory.events")))
    return {
      directory,
      currentBytes,
      peakBytes: readNumber(path.join(directory, "memory.peak")),
      highBytes,
      maxBytes,
      usageRatio: limitBytes && limitBytes > 0 ? currentBytes / limitBytes : undefined,
      swapBytes: readNumber(path.join(directory, "memory.swap.current")),
      anonBytes: stat.anon,
      fileBytes: stat.file,
      kernelBytes: stat.kernel,
      slabBytes: stat.slab,
      events: {
        low: events.low,
        high: events.high,
        max: events.max,
        oom: events.oom,
        oomKill: events.oom_kill,
        oomGroupKill: events.oom_group_kill,
      },
    }
  }

  function cgroupPids(root: string) {
    const result = new Set<number>()
    const pending = [root]
    const visited = new Set<string>()
    while (pending.length > 0) {
      const directory = pending.pop()!
      if (visited.has(directory)) continue
      visited.add(directory)
      for (const value of readText(path.join(directory, "cgroup.procs"))?.split(/\s+/) ?? []) {
        const pid = Number(value)
        if (Number.isInteger(pid) && pid > 0) result.add(pid)
      }
      try {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (entry.isDirectory()) pending.push(path.join(directory, entry.name))
        }
      } catch {}
    }
    return result
  }

  function fallbackProcesses(input: {
    pid: number
    processMemory: NodeJS.MemoryUsage
    knownProcesses: KnownProcess[]
    procRoot?: string
    platform: NodeJS.Platform
  }) {
    const main =
      input.platform === "linux"
        ? processSample({
            pid: input.pid,
            mainPid: input.pid,
            procRoot: input.procRoot,
            processMemory: input.processMemory,
          })
        : ({ pid: input.pid, role: "main", rssBytes: input.processMemory.rss } satisfies ProcessSample)
    const seen = new Set<string>([`pid:${input.pid}`])
    const children = input.knownProcesses.flatMap((known) => {
      const key = known.pid === undefined ? `id:${known.processId ?? ""}` : `pid:${known.pid}`
      if (seen.has(key)) return []
      seen.add(key)
      if (input.platform === "linux" && known.pid !== undefined) {
        return [
          processSample({
            pid: known.pid,
            mainPid: input.pid,
            procRoot: input.procRoot,
            known,
          }),
        ]
      }
      return [
        compact({
          pid: known.pid,
          processId: known.processId,
          role: "child" as const,
          rssBytes: known.rssBytes,
        }),
      ]
    })
    return [main, ...children]
  }

  function processSample(input: {
    pid: number
    mainPid: number
    procRoot?: string
    processMemory?: NodeJS.MemoryUsage
    known?: KnownProcess
  }): ProcessSample {
    const procRoot = input.procRoot ?? "/proc"
    const status = readText(path.join(procRoot, String(input.pid), "status"))
    const rollup = readText(path.join(procRoot, String(input.pid), "smaps_rollup"))
    return compact({
      pid: input.pid,
      processId: input.known?.processId,
      role: input.pid === input.mainPid ? ("main" as const) : ("child" as const),
      name: readText(path.join(procRoot, String(input.pid), "comm"))?.trim() || undefined,
      rssBytes: parseKb(status, "VmRSS") ?? input.processMemory?.rss ?? input.known?.rssBytes,
      pssBytes: parseKb(rollup, "Pss"),
    })
  }

  function finalize(input: {
    source: Source
    processes: ProcessSample[]
    events: Events
    currentBytes?: number
    peakBytes?: number
    highBytes?: number
    maxBytes?: number
    usageRatio?: number
    swapBytes?: number
    anonBytes?: number
    fileBytes?: number
    kernelBytes?: number
    slabBytes?: number
    directory?: string
  }): Snapshot {
    const rss = input.processes.flatMap((item) => (item.rssBytes === undefined ? [] : [item.rssBytes]))
    const pss = input.processes.flatMap((item) => (item.pssBytes === undefined ? [] : [item.pssBytes]))
    return {
      source: input.source,
      currentBytes: input.currentBytes,
      peakBytes: input.peakBytes,
      highBytes: input.highBytes,
      maxBytes: input.maxBytes,
      usageRatio: input.usageRatio,
      swapBytes: input.swapBytes,
      anonBytes: input.anonBytes,
      fileBytes: input.fileBytes,
      kernelBytes: input.kernelBytes,
      slabBytes: input.slabBytes,
      processCount: input.processes.length,
      rssProcessCount: rss.length,
      pssProcessCount: pss.length,
      processRssBytes: rss.length > 0 ? rss.reduce((sum, value) => sum + value, 0) : undefined,
      processPssBytes: pss.length > 0 ? pss.reduce((sum, value) => sum + value, 0) : undefined,
      events: compact(input.events),
      processes: input.processes,
    }
  }

  function parseKeyValues(value: string | undefined) {
    const result: Record<string, number> = {}
    for (const line of value?.split("\n") ?? []) {
      const [key, raw] = line.trim().split(/\s+/, 2)
      if (!key || raw === undefined) continue
      const parsed = Number(raw)
      if (Number.isFinite(parsed) && parsed >= 0) result[key] = parsed
    }
    return result
  }

  function parseKb(value: string | undefined, key: string) {
    const match = value?.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m"))
    return match ? Number(match[1]) * 1024 : undefined
  }

  function readNumber(file: string) {
    const value = readText(file)?.trim()
    if (!value || value === "max") return
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
  }

  function readText(file: string) {
    try {
      return fs.readFileSync(file, "utf8")
    } catch {
      return undefined
    }
  }

  function compact<T extends object>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
  }
}
