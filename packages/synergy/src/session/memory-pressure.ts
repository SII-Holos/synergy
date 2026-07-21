import { Log } from "@/util/log"

export namespace SessionMemoryPressure {
  const log = Log.create({ service: "session.memory-pressure" })
  const GIB = 1024 ** 3

  export type Snapshot = {
    rssBytes: number
    heapUsedBytes: number
    heapTotalBytes: number
    externalBytes: number
    arrayBuffersBytes: number
    cgroupCurrentBytes?: number
    cgroupHighBytes?: number
    cgroupMaxBytes?: number
  }

  export type Thresholds = {
    minIntervalMs: number
    rssCriticalBytes: number
    arrayBuffersCriticalBytes: number
    cgroupCriticalBytes: number
  }

  export type Decision =
    | { action: "unavailable"; reason: "gc_unavailable"; critical: boolean }
    | { action: "skip"; reason: "interval"; critical: false; nextEligibleAt: number }
    | { action: "normal"; reason: "interval_elapsed"; critical: false }
    | { action: "full_forced"; reason: "caller_requested"; critical: false }
    | { action: "critical_forced"; reason: "critical_pressure"; critical: true }

  let lastGCAt = 0
  let cachedCgroupDir: string | undefined | null

  export function currentSnapshot(): Snapshot {
    const memory = process.memoryUsage()
    return {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    }
  }

  export async function currentSnapshotWithCgroup(): Promise<Snapshot> {
    return {
      ...currentSnapshot(),
      ...(await cgroupMemory()),
    }
  }

  export function resolveThresholds(env: NodeJS.ProcessEnv = process.env, snapshot?: Snapshot): Thresholds {
    const cgroupCriticalDefault =
      finitePositive(snapshot?.cgroupHighBytes) ??
      (finitePositive(snapshot?.cgroupMaxBytes) ? Math.floor(snapshot!.cgroupMaxBytes! * 0.9) : undefined) ??
      Math.floor(10.5 * GIB)

    return {
      minIntervalMs: envNumber(env.SYNERGY_SESSION_GC_MIN_INTERVAL_MS) ?? 10_000,
      rssCriticalBytes: envNumber(env.SYNERGY_SESSION_GC_RSS_CRITICAL_BYTES) ?? Math.floor(9.5 * GIB),
      arrayBuffersCriticalBytes: envNumber(env.SYNERGY_SESSION_GC_ARRAY_BUFFERS_CRITICAL_BYTES) ?? Math.floor(8 * GIB),
      cgroupCriticalBytes: envNumber(env.SYNERGY_SESSION_GC_CGROUP_CRITICAL_BYTES) ?? cgroupCriticalDefault,
    }
  }

  export function decide(input: {
    snapshot: Snapshot
    thresholds: Thresholds
    now: number
    lastGCAt: number
    gcAvailable: boolean
    forceFull?: boolean
  }): Decision {
    const critical =
      input.snapshot.rssBytes >= input.thresholds.rssCriticalBytes ||
      input.snapshot.arrayBuffersBytes >= input.thresholds.arrayBuffersCriticalBytes ||
      (input.snapshot.cgroupCurrentBytes ?? 0) >= input.thresholds.cgroupCriticalBytes

    if (!input.gcAvailable) return { action: "unavailable", reason: "gc_unavailable", critical }
    if (critical) return { action: "critical_forced", reason: "critical_pressure", critical: true }
    if (input.forceFull) return { action: "full_forced", reason: "caller_requested", critical: false }

    const nextEligibleAt = input.lastGCAt + input.thresholds.minIntervalMs
    if (input.lastGCAt > 0 && input.now < nextEligibleAt) {
      return { action: "skip", reason: "interval", critical: false, nextEligibleAt }
    }

    return { action: "normal", reason: "interval_elapsed", critical: false }
  }

  export async function maybeCollect(input: {
    sessionID?: string
    messageID?: string
    phase: string
    full?: boolean
    forceFull?: boolean
    now?: () => number
    snapshot?: () => Snapshot | Promise<Snapshot>
    collect?: (full: boolean) => void | Promise<void>
    env?: NodeJS.ProcessEnv
  }) {
    const now = input.now?.() ?? Date.now()
    const before = input.snapshot ? await input.snapshot() : await currentSnapshotWithCgroup()
    const thresholds = resolveThresholds(input.env, before)
    const collect = input.collect ?? defaultCollect
    const decision = decide({
      snapshot: before,
      thresholds,
      now,
      lastGCAt,
      gcAvailable: input.collect !== undefined || typeof Bun.gc === "function",
      forceFull: input.forceFull,
    })

    if (decision.action === "skip" || decision.action === "unavailable") {
      log.info("gc skipped", {
        sessionID: input.sessionID,
        messageID: input.messageID,
        phase: input.phase,
        decision,
        memory: before,
        thresholds,
      })
      return { decision, before }
    }

    await collect(decision.action === "critical_forced" || decision.action === "full_forced" || input.full === true)
    lastGCAt = now
    const after = input.snapshot ? await input.snapshot() : currentSnapshot()
    log.info("gc completed", {
      sessionID: input.sessionID,
      messageID: input.messageID,
      phase: input.phase,
      decision,
      full: input.full === true,
      forceFull: input.forceFull === true,
      before,
      after,
      thresholds,
    })
    return { decision, before, after }
  }

  export function probe(phase: string, context: { sessionID?: string; messageID?: string } = {}) {
    log.debug("memory probe", {
      ...context,
      phase,
      memory: currentSnapshot(),
    })
  }

  export function resetForTest(lastRunAt = 0) {
    lastGCAt = lastRunAt
    cachedCgroupDir = undefined
  }

  async function defaultCollect(full: boolean) {
    Bun.gc(full)
  }

  async function cgroupMemory() {
    const dir = await cgroupDir()
    if (!dir) return {}
    const [current, high, max] = await Promise.all([
      readNumberFile(`${dir}/memory.current`),
      readNumberFile(`${dir}/memory.high`),
      readNumberFile(`${dir}/memory.max`),
    ])
    return {
      ...(current !== undefined ? { cgroupCurrentBytes: current } : {}),
      ...(high !== undefined ? { cgroupHighBytes: high } : {}),
      ...(max !== undefined ? { cgroupMaxBytes: max } : {}),
    }
  }

  async function cgroupDir() {
    if (cachedCgroupDir !== undefined) return cachedCgroupDir
    if (process.platform !== "linux") {
      cachedCgroupDir = null
      return cachedCgroupDir
    }
    try {
      const text = await Bun.file("/proc/self/cgroup").text()
      const unified = text
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("0::"))
      const relative = unified?.slice("0::".length).replace(/^\/+/, "")
      cachedCgroupDir = relative ? `/sys/fs/cgroup/${relative}` : "/sys/fs/cgroup"
    } catch {
      cachedCgroupDir = null
    }
    return cachedCgroupDir
  }

  async function readNumberFile(path: string) {
    try {
      const file = Bun.file(path)
      if (!(await file.exists())) return undefined
      const text = (await file.text()).trim()
      if (!text || text === "max") return undefined
      const value = Number(text)
      return Number.isFinite(value) && value > 0 ? value : undefined
    } catch {
      return undefined
    }
  }

  function envNumber(value: string | undefined) {
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  }

  function finitePositive(value: number | undefined) {
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
  }
}
