import { Log } from "../util/log"
import { SessionMemoryPressure } from "../session/memory-pressure"

export namespace CortexConcurrency {
  const log = Log.create({ service: "cortex.concurrency" })

  const counts: Map<string, number> = new Map()
  const queues: Map<string, Array<() => void>> = new Map()

  const DEFAULT_LIMIT = 8
  // Healthy runs keep the historical per-agent limit without a tight global cap.
  // Global throttling only engages under soft/critical memory pressure (#501).
  const DEFAULT_GLOBAL_LIMIT = Number.POSITIVE_INFINITY
  const SOFT_PRESSURE_GLOBAL_LIMIT = 4
  const PRESSURE_GLOBAL_LIMIT = 2

  let globalRunning = 0
  let memoryProbe: (() => SessionMemoryPressure.Snapshot) | undefined

  export function getLimit(_key: string): number {
    return DEFAULT_LIMIT
  }

  export function getGlobalLimit(snapshot = currentMemorySnapshot()): number {
    const configured = envNumber(process.env.SYNERGY_CORTEX_GLOBAL_CONCURRENCY)
    const thresholds = SessionMemoryPressure.resolveThresholds(process.env, snapshot)
    const critical =
      snapshot.rssBytes >= thresholds.rssCriticalBytes ||
      snapshot.arrayBuffersBytes >= thresholds.arrayBuffersCriticalBytes ||
      (snapshot.cgroupCurrentBytes ?? 0) >= thresholds.cgroupCriticalBytes
    if (critical) return configured ? Math.min(configured, PRESSURE_GLOBAL_LIMIT) : PRESSURE_GLOBAL_LIMIT

    // Soft pressure: start throttling once we are halfway to the critical RSS /
    // ArrayBuffer thresholds so parallel subagents do not race into the redline.
    const softRss = thresholds.rssCriticalBytes * 0.5
    const softArrayBuffers = thresholds.arrayBuffersCriticalBytes * 0.5
    if (snapshot.rssBytes >= softRss || snapshot.arrayBuffersBytes >= softArrayBuffers) {
      return configured ? Math.min(configured, SOFT_PRESSURE_GLOBAL_LIMIT) : SOFT_PRESSURE_GLOBAL_LIMIT
    }
    return configured ?? DEFAULT_GLOBAL_LIMIT
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

    // Prefer the same agent queue, then any other waiting agent, so a global
    // slot freed under memory pressure can be reused by another agent.
    const sameAgentQueue = queues.get(key)
    if (sameAgentQueue?.length) {
      const next = sameAgentQueue.shift()!
      log.info("released-to-waiting", { key, remaining: sameAgentQueue.length, globalRunning })
      next()
      return
    }

    for (const [queuedKey, queue] of queues) {
      if (!queue.length) continue
      const next = queue.shift()!
      log.info("released-to-waiting", { key: queuedKey, remaining: queue.length, globalRunning, from: key })
      next()
      return
    }

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

  export function globalStatus() {
    return {
      running: globalRunning,
      limit: getGlobalLimit(),
    }
  }

  export function reset(): void {
    counts.clear()
    queues.clear()
    globalRunning = 0
    memoryProbe = undefined
  }

  function currentMemorySnapshot(): SessionMemoryPressure.Snapshot {
    if (memoryProbe) return memoryProbe()
    return SessionMemoryPressure.currentSnapshot()
  }

  function envNumber(value: string | undefined) {
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
  }
}
