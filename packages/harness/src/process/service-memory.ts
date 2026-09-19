import { readFileSync } from "fs"
import { totalmem } from "os"
import path from "path"

const CGROUP_V2_ROOT = "/sys/fs/cgroup"

export namespace ServiceMemory {
  export type Source = "cgroup_v2" | "process_sum"
  export type Coverage = "cgroup" | "registered_processes"

  export type CgroupV2 = {
    currentBytes?: number
    highBytes?: number
    maxBytes?: number
    peakBytes?: number
    swapCurrentBytes?: number
    stat?: {
      anonBytes?: number
      fileBytes?: number
      kernelBytes?: number
      slabBytes?: number
      activeFileBytes?: number
      inactiveFileBytes?: number
      slabReclaimableBytes?: number
      slabUnreclaimableBytes?: number
      reclaimableBytes?: number
      workingSetBytes?: number
    }
    events?: {
      low?: number
      high?: number
      max?: number
      oom?: number
      oomKill?: number
      oomGroupKill?: number
    }
    pressure?: {
      some?: Pressure
      full?: Pressure
    }
  }

  export type Pressure = {
    avg10?: number
    avg60?: number
    avg300?: number
    totalMicros?: number
  }

  export type Measurement = {
    currentBytes: number
    source: Source
    coverage: Coverage
    complete: boolean
    childProcessCount: number
    measuredChildProcessCount: number
    childProcessRssBytes: number
  }

  export type MemoryBudget = {
    totalBytes: number
    limitBytes: number
    source: "cgroup_v2" | "host"
  }

  let cachedCgroupDir: string | undefined | null

  export function currentCgroupV2(): CgroupV2 | undefined {
    const directory = cgroupV2Directory()
    return directory ? readCgroupV2(directory) : undefined
  }

  export function readCgroupV2(directory: string): CgroupV2 | undefined {
    const currentBytes = readNumber(path.join(directory, "memory.current"))
    if (currentBytes === undefined) return undefined
    const stat = readKeyValues(path.join(directory, "memory.stat"))
    const events = readKeyValues(path.join(directory, "memory.events"))
    const pressure = readPressure(path.join(directory, "memory.pressure"))
    const inactiveFileBytes = stat?.inactive_file
    const slabReclaimableBytes = stat?.slab_reclaimable
    const reclaimableBytes =
      inactiveFileBytes === undefined && slabReclaimableBytes === undefined
        ? undefined
        : (inactiveFileBytes ?? 0) + (slabReclaimableBytes ?? 0)
    return {
      currentBytes,
      ...optional("highBytes", readNumber(path.join(directory, "memory.high"))),
      ...optional("maxBytes", readNumber(path.join(directory, "memory.max"))),
      ...optional("peakBytes", readNumber(path.join(directory, "memory.peak"))),
      ...optional("swapCurrentBytes", readNumber(path.join(directory, "memory.swap.current"))),
      ...(stat
        ? {
            stat: {
              ...optional("anonBytes", stat.anon),
              ...optional("fileBytes", stat.file),
              ...optional("kernelBytes", stat.kernel),
              ...optional("slabBytes", stat.slab),
              ...optional("activeFileBytes", stat.active_file),
              ...optional("inactiveFileBytes", inactiveFileBytes),
              ...optional("slabReclaimableBytes", slabReclaimableBytes),
              ...optional("slabUnreclaimableBytes", stat.slab_unreclaimable),
              ...optional("reclaimableBytes", reclaimableBytes),
              ...optional(
                "workingSetBytes",
                reclaimableBytes === undefined ? undefined : Math.max(0, currentBytes - reclaimableBytes),
              ),
            },
          }
        : {}),
      ...(events
        ? {
            events: {
              ...optional("low", events.low),
              ...optional("high", events.high),
              ...optional("max", events.max),
              ...optional("oom", events.oom),
              ...optional("oomKill", events.oom_kill),
              ...optional("oomGroupKill", events.oom_group_kill),
            },
          }
        : {}),
      ...(pressure ? { pressure } : {}),
    }
  }

  export function measure(input: {
    processRssBytes: number
    children: Array<{ rssBytes?: number }>
    cgroup?: CgroupV2
  }): Measurement {
    const measured = input.children.filter(
      (child): child is { rssBytes: number } => child.rssBytes !== undefined && Number.isFinite(child.rssBytes),
    )
    const childProcessRssBytes = measured.reduce((sum, child) => sum + child.rssBytes, 0)
    const common = {
      childProcessCount: input.children.length,
      measuredChildProcessCount: measured.length,
      childProcessRssBytes,
    }
    if (input.cgroup?.currentBytes !== undefined) {
      return {
        currentBytes: input.cgroup.currentBytes,
        source: "cgroup_v2",
        coverage: "cgroup",
        complete: true,
        ...common,
      }
    }
    return {
      currentBytes: input.processRssBytes + childProcessRssBytes,
      source: "process_sum",
      coverage: "registered_processes",
      complete: false,
      ...common,
    }
  }

  export function resetForTest() {
    cachedCgroupDir = undefined
  }

  export function memoryLimitFromDirectories(directories: readonly string[]): number | undefined {
    let limit: number | undefined
    for (const directory of directories) {
      const level = minDefined(
        readNumber(path.join(directory, "memory.max")),
        readNumber(path.join(directory, "memory.high")),
      )
      if (level === undefined) continue
      limit = limit === undefined ? level : Math.min(limit, level)
    }
    return limit
  }

  export function cgroupDirectoryChain(): string[] | undefined {
    const directory = cgroupV2Directory()
    if (!directory) return undefined
    const chain: string[] = []
    let current = directory
    while (true) {
      chain.push(current)
      if (current === CGROUP_V2_ROOT) break
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    return chain
  }

  export function cgroupMemoryLimitBytes(): number | undefined {
    const chain = cgroupDirectoryChain()
    if (!chain) return undefined
    return memoryLimitFromDirectories(chain)
  }

  export function resolveMemoryBudget(): MemoryBudget {
    const totalBytes = totalmem()
    const cgroupLimitBytes = cgroupMemoryLimitBytes()
    if (cgroupLimitBytes === undefined || cgroupLimitBytes >= totalBytes)
      return { totalBytes, limitBytes: totalBytes, source: "host" }
    return { totalBytes, limitBytes: Math.max(1, cgroupLimitBytes), source: "cgroup_v2" }
  }

  function cgroupV2Directory() {
    if (cachedCgroupDir !== undefined) return cachedCgroupDir
    if (process.platform !== "linux") {
      cachedCgroupDir = null
      return cachedCgroupDir
    }
    try {
      const unified = readFileSync("/proc/self/cgroup", "utf8")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("0::"))
      if (!unified) {
        cachedCgroupDir = null
        return cachedCgroupDir
      }
      const relative = unified.slice("0::".length).replace(/^\/+/, "")
      cachedCgroupDir = relative ? path.join(CGROUP_V2_ROOT, relative) : CGROUP_V2_ROOT
    } catch {
      cachedCgroupDir = null
    }
    return cachedCgroupDir
  }

  function readNumber(file: string) {
    try {
      const text = readFileSync(file, "utf8").trim()
      if (!text || text === "max") return undefined
      const value = Number(text)
      return Number.isFinite(value) && value >= 0 ? value : undefined
    } catch {
      return undefined
    }
  }

  function readKeyValues(file: string) {
    try {
      const result: Record<string, number> = {}
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const [key, raw] = line.trim().split(/\s+/, 2)
        const value = Number(raw)
        if (key && Number.isFinite(value) && value >= 0) result[key] = value
      }
      return Object.keys(result).length ? result : undefined
    } catch {
      return undefined
    }
  }

  function readPressure(file: string): CgroupV2["pressure"] | undefined {
    try {
      const result: NonNullable<CgroupV2["pressure"]> = {}
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const [kind, ...fields] = line.trim().split(/\s+/)
        if (kind !== "some" && kind !== "full") continue
        const values: Record<string, number> = {}
        for (const field of fields) {
          const [key, raw] = field.split("=", 2)
          const value = Number(raw)
          if (key && Number.isFinite(value) && value >= 0) values[key] = value
        }
        result[kind] = {
          ...optional("avg10", values.avg10),
          ...optional("avg60", values.avg60),
          ...optional("avg300", values.avg300),
          ...optional("totalMicros", values.total),
        }
      }
      return result.some || result.full ? result : undefined
    } catch {
      return undefined
    }
  }

  function optional(key: string, value: number | undefined): Record<string, number> {
    return value === undefined ? {} : { [key]: value }
  }

  function minDefined(a: number | undefined, b: number | undefined): number | undefined {
    if (a === undefined) return b
    if (b === undefined) return a
    return Math.min(a, b)
  }
}
