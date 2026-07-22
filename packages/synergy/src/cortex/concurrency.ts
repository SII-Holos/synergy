import { Log } from "../util/log"
import { SessionMemoryPressure } from "../session/memory-pressure"
import z from "zod"

export namespace CortexConcurrency {
  const log = Log.create({ service: "cortex.concurrency" })

  const counts: Map<string, number> = new Map()
  const queues: Map<string, Array<() => void>> = new Map()

  const DEFAULT_LIMIT = 8
  const DEFAULT_GLOBAL_LIMIT = 8
  const GIB = 1024 ** 3
  const SOFT_PRESSURE_LIMIT = 4
  const CRITICAL_PRESSURE_LIMIT = 2
  const SOFT_ARRAY_BUFFERS_BYTES = 1 * GIB
  const CRITICAL_ARRAY_BUFFERS_BYTES = 2 * GIB

  let globalRunning = 0
  let configuredGlobalLimit: number | undefined
  let memoryProbe: (() => SessionMemoryPressure.Snapshot) | undefined

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
        .describe("Advisory limit suggested by current memory pressure; never used for task admission"),
      memoryPressureReason: z
        .enum(["normal", "memory_pressure", "critical_memory_pressure"])
        .describe("Reason for the advisory memory-pressure limit"),
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
    const previous = desiredGlobalLimit()
    configuredGlobalLimit = normalizeLimit(limit)
    if (desiredGlobalLimit() > previous) wakeAllQueues()
  }

  export function getGlobalLimit(): number {
    return desiredGlobalLimit()
  }

  export function getMemoryPressure(snapshot = currentMemorySnapshot()) {
    const thresholds = SessionMemoryPressure.resolveThresholds(process.env, snapshot)
    const criticalArrayBuffers = Math.min(thresholds.arrayBuffersCriticalBytes, CRITICAL_ARRAY_BUFFERS_BYTES)
    const critical =
      snapshot.rssBytes >= thresholds.rssCriticalBytes ||
      snapshot.arrayBuffersBytes >= criticalArrayBuffers ||
      (snapshot.cgroupCurrentBytes ?? 0) >= thresholds.cgroupCriticalBytes
    if (critical) {
      return { limit: CRITICAL_PRESSURE_LIMIT, reason: "critical_memory_pressure" as const }
    }

    const softRss = thresholds.rssCriticalBytes * 0.5
    const softArrayBuffers = Math.min(thresholds.arrayBuffersCriticalBytes * 0.5, SOFT_ARRAY_BUFFERS_BYTES)
    if (snapshot.rssBytes >= softRss || snapshot.arrayBuffersBytes >= softArrayBuffers) {
      return { limit: SOFT_PRESSURE_LIMIT, reason: "memory_pressure" as const }
    }
    return { limit: null, reason: "normal" as const }
  }

  export function getMemoryPressureLimit(snapshot = currentMemorySnapshot()): number | undefined {
    return getMemoryPressure(snapshot).limit ?? undefined
  }

  export function setMemoryProbeForTest(probe?: () => SessionMemoryPressure.Snapshot) {
    memoryProbe = probe
  }

  export async function acquire(key: string): Promise<void> {
    while (true) {
      const perAgent = counts.get(key) ?? 0
      const perAgentLimit = getLimit(key)
      const globalLimit = getGlobalLimit()

      if (perAgent < perAgentLimit && globalRunning < globalLimit) {
        counts.set(key, perAgent + 1)
        globalRunning++
        log.info("acquired", {
          key,
          current: perAgent + 1,
          limit: perAgentLimit,
          globalRunning,
          globalLimit,
        })
        return
      }

      log.info("queued", {
        key,
        queueSize: (queues.get(key)?.length ?? 0) + 1,
        perAgent,
        perAgentLimit,
        globalRunning,
        globalLimit,
      })
      await new Promise<void>((resolve) => {
        const queue = queues.get(key) ?? []
        queue.push(resolve)
        queues.set(key, queue)
      })
    }
  }

  export function release(key: string): void {
    const current = counts.get(key) ?? 0
    if (current > 0) {
      counts.set(key, current - 1)
      globalRunning = Math.max(0, globalRunning - 1)
    }

    if (wakeNextQueue(key)) return

    log.info("released", { key, current: Math.max(0, current - 1), globalRunning })
  }

  export function status(): Record<string, { running: number; queued: number }> {
    const result: Record<string, { running: number; queued: number }> = {}
    for (const [key, count] of counts) {
      result[key] = {
        running: count,
        queued: queues.get(key)?.length ?? 0,
      }
    }
    return result
  }

  export function globalStatus(snapshot = currentMemorySnapshot()): GlobalStatus {
    const environment = envNumber(process.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY)
    const memoryPressure = getMemoryPressure(snapshot)
    return {
      configured: configuredGlobalLimit ?? null,
      environment: environment ?? null,
      effective: getGlobalLimit(),
      memoryPressureLimit: memoryPressure.limit,
      memoryPressureReason: memoryPressure.reason,
      source:
        environment !== undefined
          ? ("environment" as const)
          : configuredGlobalLimit !== undefined
            ? ("config" as const)
            : ("default" as const),
      perAgentLimit: DEFAULT_LIMIT,
      running: globalRunning,
      queued: Array.from(queues.values()).reduce((total, queue) => total + queue.length, 0),
    }
  }

  export function reset(): void {
    counts.clear()
    queues.clear()
    globalRunning = 0
    configuredGlobalLimit = undefined
    memoryProbe = undefined
  }

  function wakeNextQueue(preferredKey?: string): boolean {
    if (preferredKey) {
      const preferred = queues.get(preferredKey)
      if (preferred?.length) {
        preferred.shift()!()
        return true
      }
    }

    for (const queue of queues.values()) {
      if (!queue.length) continue
      queue.shift()!()
      return true
    }
    return false
  }

  function wakeAllQueues(): void {
    const waiting = Array.from(queues.values()).flatMap((queue) => queue.splice(0))
    for (const wake of waiting) wake()
  }

  function normalizeLimit(value: number | undefined): number | undefined {
    if (value === undefined) return undefined
    if (!Number.isInteger(value) || value <= 0) return undefined
    return value
  }

  function desiredGlobalLimit(): number {
    return envNumber(process.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY) ?? configuredGlobalLimit ?? DEFAULT_GLOBAL_LIMIT
  }

  function currentMemorySnapshot(): SessionMemoryPressure.Snapshot {
    if (memoryProbe) return memoryProbe()
    return SessionMemoryPressure.currentSnapshot()
  }

  function envNumber(value: string | undefined) {
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}
