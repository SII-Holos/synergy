import { Log } from "@/util/log"

export namespace SessionMemoryPressure {
  const log = Log.create({ service: "session.memory-pressure" })
  const GIB = 1024 ** 3
  const RELEASE_COALESCE_MS = 1_000

  export type Snapshot = {
    rssBytes: number
    heapUsedBytes: number
    heapTotalBytes: number
    externalBytes: number
    arrayBuffersBytes: number
    cgroupCurrentBytes?: number
    cgroupWorkingSetBytes?: number
    cgroupHighBytes?: number
    cgroupMaxBytes?: number
  }

  export type Thresholds = {
    minIntervalMs: number
    fullMinIntervalMs: number
    heapUsedSoftBytes: number
    externalSoftBytes: number
    arrayBuffersSoftBytes: number
    cgroupSoftBytes: number
    rssCriticalBytes: number
    heapUsedCriticalBytes: number
    externalCriticalBytes: number
    arrayBuffersCriticalBytes: number
    cgroupCriticalBytes: number
  }

  export type Decision =
    | { action: "unavailable"; reason: "gc_unavailable"; critical: boolean }
    | { action: "skip"; reason: "interval"; critical: boolean; nextEligibleAt: number }
    | { action: "normal"; reason: "interval_elapsed"; critical: false }
    | { action: "critical"; reason: "critical_pressure"; critical: true }
    | { action: "linux_release_full"; reason: "linux_release_pressure"; critical: boolean }

  type PressureLevel = "normal" | "soft" | "critical"

  type CollectionInput = {
    sessionID?: string
    messageID?: string
    phase: string
    now?: () => number
    snapshot?: () => Snapshot | Promise<Snapshot>
    collect?: (synchronous: boolean) => void | Promise<void>
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    releaseBoundary?: boolean
    linuxOnly?: boolean
  }

  type CollectionResult = {
    decision: Decision
    before: Snapshot
    after?: Snapshot
    thresholds: Thresholds
    pressure: PressureLevel
  }

  type ReleaseResult = CollectionResult & { releaseCount: number }

  let lastGCAt = 0
  let lastFullGCAt = 0
  let activeStreamCount = 0
  let collectionInFlight: Promise<CollectionResult> | undefined
  let cachedCgroupDir: string | undefined | null
  let pendingRelease: { count: number; input: CollectionInput } | undefined
  let releaseTimer: ReturnType<typeof setTimeout> | undefined
  let releaseFlushInFlight: Promise<ReleaseResult | undefined> | undefined

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
    const cgroupSoftDefault =
      finitePositive(snapshot?.cgroupHighBytes) ?? finitePositive(snapshot?.cgroupMaxBytes) ?? Math.floor(11 * GIB)

    return {
      minIntervalMs: envNumber(env.SYNERGY_SESSION_GC_MIN_INTERVAL_MS) ?? 10_000,
      fullMinIntervalMs: envNumber(env.SYNERGY_SESSION_GC_FULL_MIN_INTERVAL_MS) ?? 30_000,
      heapUsedSoftBytes: envNumber(env.SYNERGY_SESSION_GC_HEAP_USED_SOFT_BYTES) ?? Math.floor(1.25 * GIB),
      externalSoftBytes: envNumber(env.SYNERGY_SESSION_GC_EXTERNAL_SOFT_BYTES) ?? Math.floor(1 * GIB),
      arrayBuffersSoftBytes: envNumber(env.SYNERGY_SESSION_GC_ARRAY_BUFFERS_SOFT_BYTES) ?? Math.floor(1 * GIB),
      cgroupSoftBytes: envNumber(env.SYNERGY_SESSION_GC_CGROUP_SOFT_BYTES) ?? Math.floor(cgroupSoftDefault * 0.6),
      rssCriticalBytes: envNumber(env.SYNERGY_SESSION_GC_RSS_CRITICAL_BYTES) ?? Math.floor(9.5 * GIB),
      heapUsedCriticalBytes: envNumber(env.SYNERGY_SESSION_GC_HEAP_USED_CRITICAL_BYTES) ?? Math.floor(1.75 * GIB),
      externalCriticalBytes: envNumber(env.SYNERGY_SESSION_GC_EXTERNAL_CRITICAL_BYTES) ?? Math.floor(1.5 * GIB),
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
  }): Decision {
    const critical = pressureLevel(input.snapshot, input.thresholds) === "critical"

    if (!input.gcAvailable) return { action: "unavailable", reason: "gc_unavailable", critical }

    const nextEligibleAt = input.lastGCAt + input.thresholds.minIntervalMs
    if (input.lastGCAt > 0 && input.now < nextEligibleAt) {
      return { action: "skip", reason: "interval", critical, nextEligibleAt }
    }

    if (critical) return { action: "critical", reason: "critical_pressure", critical: true }
    return { action: "normal", reason: "interval_elapsed", critical: false }
  }

  export function pressureLevel(snapshot: Snapshot, thresholds: Thresholds): PressureLevel {
    if (
      snapshot.rssBytes >= thresholds.rssCriticalBytes ||
      snapshot.heapUsedBytes >= thresholds.heapUsedCriticalBytes ||
      snapshot.externalBytes >= thresholds.externalCriticalBytes ||
      snapshot.arrayBuffersBytes >= thresholds.arrayBuffersCriticalBytes ||
      (snapshot.cgroupCurrentBytes ?? 0) >= thresholds.cgroupCriticalBytes
    )
      return "critical"
    if (
      snapshot.heapUsedBytes >= thresholds.heapUsedSoftBytes ||
      snapshot.externalBytes >= thresholds.externalSoftBytes ||
      snapshot.arrayBuffersBytes >= thresholds.arrayBuffersSoftBytes ||
      (snapshot.cgroupWorkingSetBytes ?? 0) >= thresholds.cgroupSoftBytes
    )
      return "soft"
    return "normal"
  }

  export async function maybeCollect(input: CollectionInput): Promise<CollectionResult> {
    if (collectionInFlight) return collectionInFlight

    const pending = collectOnce(input)
    collectionInFlight = pending
    try {
      return await pending
    } finally {
      if (collectionInFlight === pending) collectionInFlight = undefined
    }
  }

  async function collectOnce(input: CollectionInput): Promise<CollectionResult> {
    const now = input.now?.() ?? Date.now()
    const before = input.snapshot ? await input.snapshot() : await currentSnapshotWithCgroup()
    const thresholds = resolveThresholds(input.env, before)
    const pressure = pressureLevel(before, thresholds)
    const collect = input.collect ?? defaultCollect
    let decision = decide({
      snapshot: before,
      thresholds,
      now,
      lastGCAt,
      gcAvailable: input.collect !== undefined || typeof Bun.gc === "function",
    })
    const platform = input.platform ?? process.platform
    const fullEligibleAt = lastFullGCAt + thresholds.fullMinIntervalMs
    const linuxReleaseFull =
      platform === "linux" &&
      input.releaseBoundary === true &&
      activeStreamCount === 0 &&
      pressure !== "normal" &&
      (lastFullGCAt === 0 || now >= fullEligibleAt)
    if (linuxReleaseFull && decision.action !== "unavailable") {
      decision = {
        action: "linux_release_full",
        reason: "linux_release_pressure",
        critical: pressure === "critical",
      }
    }

    if (decision.action === "skip" || decision.action === "unavailable") {
      log.debug("gc skipped", {
        sessionID: input.sessionID,
        messageID: input.messageID,
        phase: input.phase,
        decision,
        memory: before,
        thresholds,
      })
      return { decision, before, thresholds, pressure }
    }

    const synchronous = decision.action === "linux_release_full"
    await collect(synchronous)
    lastGCAt = now
    if (synchronous) lastFullGCAt = now
    const after = input.snapshot ? await input.snapshot() : currentSnapshot()
    log.info("gc completed", {
      sessionID: input.sessionID,
      messageID: input.messageID,
      phase: input.phase,
      decision,
      before,
      after,
      thresholds,
      collection: synchronous ? "full" : "normal",
    })
    return { decision, before, after, thresholds, pressure }
  }

  export function signalRelease(input: CollectionInput) {
    if (input.linuxOnly && (input.platform ?? process.platform) !== "linux") return
    input = { ...input, releaseBoundary: true }
    if (pendingRelease) {
      pendingRelease.count++
      pendingRelease.input = input
    } else {
      pendingRelease = { count: 1, input }
    }
    scheduleReleaseFlush()
  }

  function scheduleReleaseFlush() {
    if (!pendingRelease || releaseTimer || releaseFlushInFlight) return
    const delay = envNumber(pendingRelease.input.env?.SYNERGY_SESSION_GC_RELEASE_COALESCE_MS) ?? RELEASE_COALESCE_MS
    releaseTimer = setTimeout(() => {
      releaseTimer = undefined
      void flushReleaseSignals().catch((error) => {
        log.warn("release-triggered gc failed", { error })
      })
    }, delay)
    releaseTimer.unref()
  }

  async function flushReleaseSignals(): Promise<ReleaseResult | undefined> {
    if (releaseFlushInFlight) return releaseFlushInFlight
    const pending = pendingRelease
    if (!pending) return
    pendingRelease = undefined

    const flush = (async () => {
      const result = await maybeCollect(pending.input)
      return { ...result, releaseCount: pending.count }
    })()
    releaseFlushInFlight = flush
    try {
      return await flush
    } finally {
      if (releaseFlushInFlight === flush) releaseFlushInFlight = undefined
      scheduleReleaseFlush()
    }
  }

  export async function flushReleaseSignalsForTest() {
    if (releaseTimer) {
      clearTimeout(releaseTimer)
      releaseTimer = undefined
    }
    if (releaseFlushInFlight) await releaseFlushInFlight
    if (releaseTimer) {
      clearTimeout(releaseTimer)
      releaseTimer = undefined
    }
    return flushReleaseSignals()
  }

  export function probe(phase: string, context: { sessionID?: string; messageID?: string } = {}) {
    log.debug("memory probe", {
      ...context,
      phase,
      memory: currentSnapshot(),
    })
  }

  export function streamStarted() {
    activeStreamCount++
  }

  export function streamDisposed() {
    activeStreamCount = Math.max(0, activeStreamCount - 1)
  }

  export function resetForTest(lastRunAt = 0, lastFullRunAt = 0) {
    if (releaseTimer) clearTimeout(releaseTimer)
    lastGCAt = lastRunAt
    lastFullGCAt = lastFullRunAt
    activeStreamCount = 0
    collectionInFlight = undefined
    cachedCgroupDir = undefined
    pendingRelease = undefined
    releaseTimer = undefined
    releaseFlushInFlight = undefined
  }

  async function defaultCollect() {
    Bun.gc(false)
  }

  async function cgroupMemory() {
    const dir = await cgroupDir()
    if (!dir) return {}
    const [current, high, max, stat] = await Promise.all([
      readNumberFile(`${dir}/memory.current`),
      readNumberFile(`${dir}/memory.high`),
      readNumberFile(`${dir}/memory.max`),
      readKeyValueFile(`${dir}/memory.stat`),
    ])
    const reclaimable = stat === undefined ? undefined : (stat.inactive_file ?? 0) + (stat.slab_reclaimable ?? 0)
    return {
      ...(current !== undefined ? { cgroupCurrentBytes: current } : {}),
      ...(current !== undefined && reclaimable !== undefined
        ? { cgroupWorkingSetBytes: Math.max(0, current - reclaimable) }
        : {}),
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

  async function readKeyValueFile(path: string) {
    try {
      const file = Bun.file(path)
      if (!(await file.exists())) return undefined
      const result: Record<string, number> = {}
      for (const line of (await file.text()).split("\n")) {
        const [key, raw] = line.trim().split(/\s+/, 2)
        const value = Number(raw)
        if (key && Number.isFinite(value) && value >= 0) result[key] = value
      }
      return Object.keys(result).length > 0 ? result : undefined
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
