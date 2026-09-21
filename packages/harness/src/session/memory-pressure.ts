import { RuntimeContext } from "../lifecycle/context"
import { Log } from "../util/log"
import { ServiceMemory } from "../process/service-memory"

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
    | {
        action: "skip"
        reason: "interval" | "no_process_pressure" | "service_pressure_external"
        critical: boolean
        nextEligibleAt?: number
      }
    | { action: "normal"; reason: "interval_elapsed"; critical: false }
    | { action: "critical"; reason: "critical_pressure"; critical: true }
    | { action: "linux_release_full"; reason: "linux_release_pressure"; critical: boolean }

  export type PressureLevel = "normal" | "soft" | "critical"

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
    processPressure: PressureLevel
    servicePressure: PressureLevel
  }

  type ReleaseResult = CollectionResult & { releaseCount: number }
  type CollectionPriority = 0 | 1
  type ActiveCollection = { promise: Promise<CollectionResult> }
  type PendingCollection = {
    input: CollectionInput
    priority: CollectionPriority
    promise: Promise<CollectionResult>
    resolve: (result: CollectionResult) => void
    reject: (error: unknown) => void
  }

  const runtimeState = RuntimeContext.state(() => ({
    lastGCAt: 0,
    lastFullGCAt: 0,
    activeStreamCount: 0,
    collectionInFlight: undefined as ActiveCollection | undefined,
    pendingCollection: undefined as PendingCollection | undefined,
    pendingRelease: undefined as { count: number; input: CollectionInput } | undefined,
    releaseTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    releaseFlushInFlight: undefined as Promise<ReleaseResult | undefined> | undefined,
    lastAssessment: undefined as
      | {
          at: number
          pressure: PressureLevel
          processPressure: PressureLevel
          servicePressure: PressureLevel
          decision: Decision
        }
      | undefined,
    lastRecovery: undefined as
      | {
          action: "gc"
          reason: string
          at: number
          beforeBytes: number
          afterBytes: number
          reclaimedBytes: number
        }
      | undefined,
  }))

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

  export function currentSnapshotWithCgroup(): Snapshot {
    const cgroup = ServiceMemory.currentCgroupV2()
    return {
      ...currentSnapshot(),
      ...(cgroup?.currentBytes === undefined ? {} : { cgroupCurrentBytes: cgroup.currentBytes }),
      ...(cgroup?.stat?.workingSetBytes === undefined ? {} : { cgroupWorkingSetBytes: cgroup.stat.workingSetBytes }),
      ...(cgroup?.highBytes === undefined ? {} : { cgroupHighBytes: cgroup.highBytes }),
      ...(cgroup?.maxBytes === undefined ? {} : { cgroupMaxBytes: cgroup.maxBytes }),
    }
  }

  export function resolveThresholds(
    env: NodeJS.ProcessEnv = RuntimeContext.current().host.env,
    snapshot?: Snapshot,
  ): Thresholds {
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
    const critical = processPressureLevel(input.snapshot, input.thresholds) === "critical"

    if (!input.gcAvailable) return { action: "unavailable", reason: "gc_unavailable", critical }

    const nextEligibleAt = input.lastGCAt + input.thresholds.minIntervalMs
    if (input.lastGCAt > 0 && input.now < nextEligibleAt) {
      return { action: "skip", reason: "interval", critical, nextEligibleAt }
    }

    if (critical) return { action: "critical", reason: "critical_pressure", critical: true }
    return { action: "normal", reason: "interval_elapsed", critical: false }
  }

  export function pressureLevel(snapshot: Snapshot, thresholds: Thresholds): PressureLevel {
    return maxPressure(processPressureLevel(snapshot, thresholds), servicePressureLevel(snapshot, thresholds))
  }

  export function processPressureLevel(snapshot: Snapshot, thresholds: Thresholds): PressureLevel {
    if (
      snapshot.rssBytes >= thresholds.rssCriticalBytes ||
      snapshot.heapUsedBytes >= thresholds.heapUsedCriticalBytes ||
      snapshot.externalBytes >= thresholds.externalCriticalBytes ||
      snapshot.arrayBuffersBytes >= thresholds.arrayBuffersCriticalBytes
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

  export function servicePressureLevel(snapshot: Snapshot, thresholds: Thresholds): PressureLevel {
    if ((snapshot.cgroupCurrentBytes ?? 0) >= thresholds.cgroupCriticalBytes) return "critical"
    if ((snapshot.cgroupWorkingSetBytes ?? 0) >= thresholds.cgroupSoftBytes) return "soft"
    return "normal"
  }

  export function maybeCollect(input: CollectionInput): Promise<CollectionResult> {
    const instanceState = runtimeState()

    const priority = collectionPriority(input)
    const active = instanceState.collectionInFlight
    if (!active) return startCollection(input)

    const queued = instanceState.pendingCollection
    if (queued) {
      if (priority >= queued.priority) {
        queued.input = input
        queued.priority = priority
      }
      return queued.promise
    }
    if (priority === 0) return active.promise

    let resolve!: (result: CollectionResult) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<CollectionResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    instanceState.pendingCollection = { input, priority, promise, resolve, reject }
    return promise
  }

  function startCollection(input: CollectionInput): Promise<CollectionResult> {
    const instanceState = runtimeState()

    const promise = collectOnce(input)
    instanceState.collectionInFlight = { promise }
    const finish = () => completeCollection(promise)
    void promise.then(finish, finish)
    return promise
  }

  function completeCollection(promise: Promise<CollectionResult>) {
    const instanceState = runtimeState()

    if (instanceState.collectionInFlight?.promise !== promise) return
    instanceState.collectionInFlight = undefined
    const queued = instanceState.pendingCollection
    instanceState.pendingCollection = undefined
    if (!queued) return
    void startCollection(queued.input).then(queued.resolve, queued.reject)
  }

  function collectionPriority(input: CollectionInput): CollectionPriority {
    return (input.platform ?? process.platform) === "linux" && input.releaseBoundary === true ? 1 : 0
  }

  async function collectOnce(input: CollectionInput): Promise<CollectionResult> {
    const instanceState = runtimeState()

    const now = input.now?.() ?? Date.now()
    const before = input.snapshot ? await input.snapshot() : currentSnapshotWithCgroup()
    const thresholds = resolveThresholds(input.env, before)
    const processPressure = processPressureLevel(before, thresholds)
    const servicePressure = servicePressureLevel(before, thresholds)
    const pressure = maxPressure(processPressure, servicePressure)
    const collect = input.collect ?? defaultCollect
    let decision = decide({
      snapshot: before,
      thresholds,
      now,
      lastGCAt: instanceState.lastGCAt,
      gcAvailable: input.collect !== undefined || typeof Bun.gc === "function",
    })
    const platform = input.platform ?? process.platform
    const fullEligibleAt = instanceState.lastFullGCAt + thresholds.fullMinIntervalMs
    const linuxRelease = platform === "linux" && input.releaseBoundary === true
    const linuxServiceOnly = platform === "linux" && processPressure === "normal" && servicePressure !== "normal"
    if (linuxServiceOnly && decision.action !== "unavailable") {
      decision = {
        action: "skip",
        reason: "service_pressure_external",
        critical: false,
      }
    } else if (linuxRelease && processPressure === "normal" && decision.action !== "unavailable") {
      decision = {
        action: "skip",
        reason: "no_process_pressure",
        critical: false,
      }
    }
    const linuxReleaseFull =
      platform === "linux" &&
      input.releaseBoundary === true &&
      instanceState.activeStreamCount === 0 &&
      processPressure === "critical" &&
      (instanceState.lastFullGCAt === 0 || now >= fullEligibleAt)
    if (linuxReleaseFull && decision.action !== "unavailable" && decision.action !== "skip") {
      decision = {
        action: "linux_release_full",
        reason: "linux_release_pressure",
        critical: true,
      }
    }

    if (decision.action === "skip" || decision.action === "unavailable") {
      instanceState.lastAssessment = { at: now, pressure, processPressure, servicePressure, decision }
      log.debug("gc skipped", {
        sessionID: input.sessionID,
        messageID: input.messageID,
        phase: input.phase,
        decision,
        memory: before,
        thresholds,
      })
      return { decision, before, thresholds, pressure, processPressure, servicePressure }
    }

    const synchronous = decision.action === "linux_release_full"
    await collect(synchronous)
    instanceState.lastGCAt = now
    if (synchronous) instanceState.lastFullGCAt = now
    const after = input.snapshot ? await input.snapshot() : currentSnapshot()
    instanceState.lastAssessment = { at: now, pressure, processPressure, servicePressure, decision }
    instanceState.lastRecovery = {
      action: "gc",
      reason: decision.reason,
      at: now,
      beforeBytes: before.heapUsedBytes + before.externalBytes,
      afterBytes: after.heapUsedBytes + after.externalBytes,
      reclaimedBytes: Math.max(
        0,
        before.heapUsedBytes + before.externalBytes - after.heapUsedBytes - after.externalBytes,
      ),
    }
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
    return { decision, before, after, thresholds, pressure, processPressure, servicePressure }
  }

  export function signalRelease(input: CollectionInput) {
    const instanceState = runtimeState()

    if (input.linuxOnly && (input.platform ?? process.platform) !== "linux") return
    input = { ...input, releaseBoundary: true }
    if (instanceState.pendingRelease) {
      instanceState.pendingRelease.count++
      instanceState.pendingRelease.input = input
    } else {
      instanceState.pendingRelease = { count: 1, input }
    }
    scheduleReleaseFlush()
  }

  function scheduleReleaseFlush() {
    const instanceState = runtimeState()

    if (!instanceState.pendingRelease || instanceState.releaseTimer || instanceState.releaseFlushInFlight) return
    const delay =
      envNumber(instanceState.pendingRelease.input.env?.SYNERGY_SESSION_GC_RELEASE_COALESCE_MS) ?? RELEASE_COALESCE_MS
    instanceState.releaseTimer = setTimeout(() => {
      instanceState.releaseTimer = undefined
      void flushReleaseSignals().catch((error) => {
        log.warn("release-triggered gc failed", { error })
      })
    }, delay)
    instanceState.releaseTimer.unref()
  }

  async function flushReleaseSignals(): Promise<ReleaseResult | undefined> {
    const instanceState = runtimeState()

    if (instanceState.releaseFlushInFlight) return instanceState.releaseFlushInFlight
    const pending = instanceState.pendingRelease
    if (!pending) return
    instanceState.pendingRelease = undefined

    const flush = (async () => {
      const result = await maybeCollect(pending.input)
      return { ...result, releaseCount: pending.count }
    })()
    instanceState.releaseFlushInFlight = flush
    try {
      return await flush
    } finally {
      if (instanceState.releaseFlushInFlight === flush) instanceState.releaseFlushInFlight = undefined
      scheduleReleaseFlush()
    }
  }

  export async function flushReleaseSignalsForTest() {
    const instanceState = runtimeState()

    if (instanceState.releaseTimer) {
      clearTimeout(instanceState.releaseTimer)
      instanceState.releaseTimer = undefined
    }
    if (instanceState.releaseFlushInFlight) await instanceState.releaseFlushInFlight
    if (instanceState.releaseTimer) {
      clearTimeout(instanceState.releaseTimer)
      instanceState.releaseTimer = undefined
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

  export function stats() {
    const instanceState = runtimeState()

    return { lastAssessment: instanceState.lastAssessment, lastRecovery: instanceState.lastRecovery }
  }

  export function streamStarted() {
    const instanceState = runtimeState()

    instanceState.activeStreamCount++
  }

  export function streamDisposed() {
    const instanceState = runtimeState()

    instanceState.activeStreamCount = Math.max(0, instanceState.activeStreamCount - 1)
  }

  export function resetForTest(lastRunAt = 0, lastFullRunAt = 0) {
    const instanceState = runtimeState()

    if (instanceState.releaseTimer) clearTimeout(instanceState.releaseTimer)
    instanceState.lastGCAt = lastRunAt
    instanceState.lastFullGCAt = lastFullRunAt
    instanceState.activeStreamCount = 0
    instanceState.collectionInFlight = undefined
    instanceState.pendingCollection = undefined
    instanceState.pendingRelease = undefined
    instanceState.releaseTimer = undefined
    instanceState.releaseFlushInFlight = undefined
    instanceState.lastAssessment = undefined
    instanceState.lastRecovery = undefined
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

  function maxPressure(left: PressureLevel, right: PressureLevel) {
    const rank: Record<PressureLevel, number> = { normal: 0, soft: 1, critical: 2 }
    return rank[left] >= rank[right] ? left : right
  }
}
