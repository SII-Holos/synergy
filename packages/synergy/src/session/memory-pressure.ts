import { Log } from "@/util/log"
import { ServiceMemory } from "@/observability/service-memory"

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
    cgroupHighBytes?: number
    cgroupMaxBytes?: number
  }

  export type Thresholds = {
    minIntervalMs: number
    heapUsedSoftBytes: number
    externalSoftBytes: number
    arrayBuffersSoftBytes: number
    rssCriticalBytes: number
    heapUsedCriticalBytes: number
    externalCriticalBytes: number
    arrayBuffersCriticalBytes: number
    cgroupCriticalBytes: number
  }

  export type Decision =
    | { action: "unavailable"; reason: "gc_unavailable"; critical: boolean }
    | { action: "skip"; reason: "interval"; critical: false; nextEligibleAt: number }
    | { action: "normal"; reason: "interval_elapsed"; critical: false }
    | { action: "critical_forced"; reason: "critical_pressure"; critical: true }

  type PressureLevel = "normal" | "soft" | "critical"

  type CollectionInput = {
    sessionID?: string
    messageID?: string
    phase: string
    now?: () => number
    snapshot?: () => Snapshot | Promise<Snapshot>
    collect?: (synchronous: boolean) => void | Promise<void>
    env?: NodeJS.ProcessEnv
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
    const cgroup = ServiceMemory.readCgroup()
    return {
      ...currentSnapshot(),
      ...(cgroup?.currentBytes !== undefined ? { cgroupCurrentBytes: cgroup.currentBytes } : {}),
      ...(cgroup?.highBytes !== undefined ? { cgroupHighBytes: cgroup.highBytes } : {}),
      ...(cgroup?.maxBytes !== undefined ? { cgroupMaxBytes: cgroup.maxBytes } : {}),
    }
  }

  export function resolveThresholds(env: NodeJS.ProcessEnv = process.env, snapshot?: Snapshot): Thresholds {
    const cgroupCriticalDefault =
      finitePositive(snapshot?.cgroupHighBytes) ??
      (finitePositive(snapshot?.cgroupMaxBytes) ? Math.floor(snapshot!.cgroupMaxBytes! * 0.9) : undefined) ??
      Math.floor(10.5 * GIB)

    return {
      minIntervalMs: envNumber(env.SYNERGY_SESSION_GC_MIN_INTERVAL_MS) ?? 10_000,
      heapUsedSoftBytes: envNumber(env.SYNERGY_SESSION_GC_HEAP_USED_SOFT_BYTES) ?? Math.floor(1.25 * GIB),
      externalSoftBytes: envNumber(env.SYNERGY_SESSION_GC_EXTERNAL_SOFT_BYTES) ?? Math.floor(1 * GIB),
      arrayBuffersSoftBytes: envNumber(env.SYNERGY_SESSION_GC_ARRAY_BUFFERS_SOFT_BYTES) ?? Math.floor(1 * GIB),
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
    if (critical) return { action: "critical_forced", reason: "critical_pressure", critical: true }

    const nextEligibleAt = input.lastGCAt + input.thresholds.minIntervalMs
    if (input.lastGCAt > 0 && input.now < nextEligibleAt) {
      return { action: "skip", reason: "interval", critical: false, nextEligibleAt }
    }

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
      snapshot.arrayBuffersBytes >= thresholds.arrayBuffersSoftBytes
    )
      return "soft"
    return "normal"
  }

  export async function maybeCollect(input: CollectionInput): Promise<CollectionResult> {
    const now = input.now?.() ?? Date.now()
    const before = input.snapshot ? await input.snapshot() : await currentSnapshotWithCgroup()
    const thresholds = resolveThresholds(input.env, before)
    const pressure = pressureLevel(before, thresholds)
    const collect = input.collect ?? defaultCollect
    const decision = decide({
      snapshot: before,
      thresholds,
      now,
      lastGCAt,
      gcAvailable: input.collect !== undefined || typeof Bun.gc === "function",
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
      return { decision, before, thresholds, pressure }
    }

    await collect(decision.action === "critical_forced")
    lastGCAt = now
    const after = input.snapshot ? await input.snapshot() : currentSnapshot()
    log.info("gc completed", {
      sessionID: input.sessionID,
      messageID: input.messageID,
      phase: input.phase,
      decision,
      before,
      after,
      thresholds,
    })
    return { decision, before, after, thresholds, pressure }
  }

  export function signalRelease(input: CollectionInput) {
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

  export function resetForTest(lastRunAt = 0) {
    if (releaseTimer) clearTimeout(releaseTimer)
    lastGCAt = lastRunAt
    pendingRelease = undefined
    releaseTimer = undefined
    releaseFlushInFlight = undefined
  }

  async function defaultCollect(synchronous: boolean) {
    Bun.gc(synchronous)
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
