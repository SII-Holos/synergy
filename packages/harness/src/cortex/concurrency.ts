import { RuntimeContext } from "../lifecycle/context"
import { Log } from "../util/log"
import { SessionMemoryPressure } from "../session/memory-pressure"
import z from "zod"

export namespace CortexConcurrency {
  const log = Log.create({ service: "cortex.concurrency" })

  const runtimeState = RuntimeContext.state(() => ({
    counts: new Map() as Map<string, number>,
    queues: new Map() as Map<string, Array<() => void>>,
    globalRunning: 0,
    configuredGlobalLimit: undefined as number | undefined,
    memoryProbe: undefined as (() => SessionMemoryPressure.Snapshot) | undefined,
    pressureRecheckTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  }))

  const DEFAULT_LIMIT = 8
  const DEFAULT_GLOBAL_LIMIT = 8
  const GIB = 1024 ** 3
  const SOFT_PRESSURE_LIMIT = 4
  const CRITICAL_PRESSURE_LIMIT = 2
  const SOFT_ARRAY_BUFFERS_BYTES = 1 * GIB
  const CRITICAL_ARRAY_BUFFERS_BYTES = 2 * GIB
  const PRESSURE_RECHECK_MS = 1_000

  export const GlobalStatus = z
    .object({
      configured: z.number().int().positive().nullable().describe("User-configured global limit, or null when unset"),
      environment: z.number().int().positive().nullable().describe("Process environment override, or null when unset"),
      effective: z.number().int().positive().describe("Actual admission limit from environment, config, or default"),
      memoryPressureLimit: z
        .number()
        .int()
        .positive()
        .nullable()
        .describe("Memory-pressure ceiling applied to new task admission"),
      memoryPressureReason: z
        .enum(["normal", "memory_pressure", "critical_memory_pressure"])
        .describe("Reason for the memory-pressure admission ceiling"),
      source: z.enum(["default", "config", "environment"]).describe("Source of the effective admission limit"),
      perAgentLimit: z.number().int().positive().describe("Fixed maximum for each individual agent"),
      running: z.number().int().nonnegative().describe("Currently admitted Cortex tasks"),
      queued: z.number().int().nonnegative().describe("Cortex tasks waiting for an admission slot"),
    })
    .meta({ ref: "CortexConcurrencyStatus" })
  export type GlobalStatus = z.infer<typeof GlobalStatus>

  export function getLimit(_key: string): number {
    return DEFAULT_LIMIT
  }

  export function configure(limit: number | undefined): void {
    const instanceState = runtimeState()

    const previous = getGlobalLimit()
    instanceState.configuredGlobalLimit = normalizeLimit(limit)
    if (getGlobalLimit() > previous) wakeAllQueues()
  }

  export function getGlobalLimit(): number {
    return effectiveGlobalLimit(currentMemorySnapshot())
  }

  export function getMemoryPressure(snapshot = currentMemorySnapshot()) {
    const thresholds = SessionMemoryPressure.resolveThresholds(RuntimeContext.current().host.env, snapshot)
    const pressure = SessionMemoryPressure.pressureLevel(snapshot, thresholds)
    const criticalArrayBuffers = Math.min(thresholds.arrayBuffersCriticalBytes, CRITICAL_ARRAY_BUFFERS_BYTES)
    const critical =
      pressure === "critical" ||
      snapshot.rssBytes >= thresholds.rssCriticalBytes ||
      snapshot.arrayBuffersBytes >= criticalArrayBuffers ||
      (snapshot.cgroupCurrentBytes ?? 0) >= thresholds.cgroupCriticalBytes
    if (critical) {
      return { limit: CRITICAL_PRESSURE_LIMIT, reason: "critical_memory_pressure" as const }
    }

    const softRss = thresholds.rssCriticalBytes * 0.5
    const softArrayBuffers = Math.min(thresholds.arrayBuffersCriticalBytes * 0.5, SOFT_ARRAY_BUFFERS_BYTES)
    if (pressure === "soft" || snapshot.rssBytes >= softRss || snapshot.arrayBuffersBytes >= softArrayBuffers) {
      return { limit: SOFT_PRESSURE_LIMIT, reason: "memory_pressure" as const }
    }
    return { limit: null, reason: "normal" as const }
  }

  export function getMemoryPressureLimit(snapshot = currentMemorySnapshot()): number | undefined {
    return getMemoryPressure(snapshot).limit ?? undefined
  }

  export function setMemoryProbeForTest(probe?: () => SessionMemoryPressure.Snapshot) {
    const instanceState = runtimeState()

    instanceState.memoryProbe = probe
  }

  export async function acquire(key: string): Promise<void> {
    const instanceState = runtimeState()

    while (true) {
      const perAgent = instanceState.counts.get(key) ?? 0
      const perAgentLimit = getLimit(key)
      const globalLimit = getGlobalLimit()

      if (perAgent < perAgentLimit && instanceState.globalRunning < globalLimit) {
        instanceState.counts.set(key, perAgent + 1)
        instanceState.globalRunning++
        log.info("acquired", {
          key,
          current: perAgent + 1,
          limit: perAgentLimit,
          globalRunning: instanceState.globalRunning,
          globalLimit,
        })
        return
      }

      log.info("queued", {
        key,
        queueSize: (instanceState.queues.get(key)?.length ?? 0) + 1,
        perAgent,
        perAgentLimit,
        globalRunning: instanceState.globalRunning,
        globalLimit,
      })
      await new Promise<void>((resolve) => {
        const queue = instanceState.queues.get(key) ?? []
        queue.push(resolve)
        instanceState.queues.set(key, queue)
        schedulePressureRecheck()
      })
    }
  }

  export function release(key: string): void {
    const instanceState = runtimeState()

    const current = instanceState.counts.get(key) ?? 0
    if (current > 0) {
      instanceState.counts.set(key, current - 1)
      instanceState.globalRunning = Math.max(0, instanceState.globalRunning - 1)
    }

    if (wakeNextQueue(key)) return

    log.info("released", { key, current: Math.max(0, current - 1), globalRunning: instanceState.globalRunning })
  }

  export function status(): Record<string, { running: number; queued: number }> {
    const instanceState = runtimeState()

    const result: Record<string, { running: number; queued: number }> = {}
    for (const [key, count] of instanceState.counts) {
      result[key] = {
        running: count,
        queued: instanceState.queues.get(key)?.length ?? 0,
      }
    }
    return result
  }

  export function globalStatus(snapshot = currentMemorySnapshot()): GlobalStatus {
    const instanceState = runtimeState()

    const environment = envNumber(RuntimeContext.current().host.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY)
    const memoryPressure = getMemoryPressure(snapshot)
    return {
      configured: instanceState.configuredGlobalLimit ?? null,
      environment: environment ?? null,
      effective: effectiveGlobalLimit(snapshot),
      memoryPressureLimit: memoryPressure.limit,
      memoryPressureReason: memoryPressure.reason,
      source:
        environment !== undefined
          ? ("environment" as const)
          : instanceState.configuredGlobalLimit !== undefined
            ? ("config" as const)
            : ("default" as const),
      perAgentLimit: DEFAULT_LIMIT,
      running: instanceState.globalRunning,
      queued: Array.from(instanceState.queues.values()).reduce((total, queue) => total + queue.length, 0),
    }
  }

  export function reset(): void {
    const instanceState = runtimeState()

    if (instanceState.pressureRecheckTimer) clearTimeout(instanceState.pressureRecheckTimer)
    instanceState.counts.clear()
    instanceState.queues.clear()
    instanceState.globalRunning = 0
    instanceState.configuredGlobalLimit = undefined
    instanceState.memoryProbe = undefined
    instanceState.pressureRecheckTimer = undefined
  }

  function wakeNextQueue(preferredKey?: string): boolean {
    const instanceState = runtimeState()

    if (preferredKey) {
      const preferred = instanceState.queues.get(preferredKey)
      if (preferred?.length) {
        preferred.shift()!()
        return true
      }
    }

    for (const queue of instanceState.queues.values()) {
      if (!queue.length) continue
      queue.shift()!()
      return true
    }
    return false
  }

  function wakeAllQueues(): void {
    const instanceState = runtimeState()

    const waiting = Array.from(instanceState.queues.values()).flatMap((queue) => queue.splice(0))
    for (const wake of waiting) wake()
  }

  function schedulePressureRecheck(): void {
    const instanceState = runtimeState()

    if (instanceState.pressureRecheckTimer || getMemoryPressureLimit() === undefined) return
    instanceState.pressureRecheckTimer = setTimeout(() => {
      instanceState.pressureRecheckTimer = undefined
      wakeAllQueues()
    }, PRESSURE_RECHECK_MS)
    instanceState.pressureRecheckTimer.unref()
  }

  function normalizeLimit(value: number | undefined): number | undefined {
    if (value === undefined) return undefined
    if (!Number.isInteger(value) || value <= 0) return undefined
    return value
  }

  export function desiredGlobalLimit(): number {
    const instanceState = runtimeState()

    return (
      envNumber(RuntimeContext.current().host.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY) ??
      instanceState.configuredGlobalLimit ??
      DEFAULT_GLOBAL_LIMIT
    )
  }

  function effectiveGlobalLimit(snapshot: SessionMemoryPressure.Snapshot): number {
    const pressureLimit = getMemoryPressureLimit(snapshot)
    return pressureLimit === undefined ? desiredGlobalLimit() : Math.min(desiredGlobalLimit(), pressureLimit)
  }

  function currentMemorySnapshot(): SessionMemoryPressure.Snapshot {
    const instanceState = runtimeState()

    if (instanceState.memoryProbe) return instanceState.memoryProbe()
    return SessionMemoryPressure.currentSnapshot()
  }

  function envNumber(value: string | undefined) {
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}
