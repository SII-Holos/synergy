import { Log } from "../util/log"

export namespace CortexConcurrency {
  const log = Log.create({ service: "cortex.concurrency" })

  const counts: Map<string, number> = new Map()
  const queues: Map<string, Array<() => void>> = new Map()

  const DEFAULT_LIMIT = 5

  export function getLimit(_key: string): number {
    return DEFAULT_LIMIT
  }

  export async function acquire(key: string): Promise<void> {
    const current = counts.get(key) ?? 0
    const limit = getLimit(key)

    if (current < limit) {
      counts.set(key, current + 1)
      log.info("acquired", { key, current: current + 1, limit })
      return
    }

    log.info("queued", { key, queueSize: (queues.get(key)?.length ?? 0) + 1 })
    return new Promise((resolve) => {
      const queue = queues.get(key) ?? []
      queue.push(resolve)
      queues.set(key, queue)
    })
  }

  export function release(key: string): void {
    const queue = queues.get(key)
    if (queue?.length) {
      const next = queue.shift()!
      log.info("released-to-waiting", { key, remaining: queue.length })
      next()
      return
    }

    const current = counts.get(key) ?? 1
    counts.set(key, Math.max(0, current - 1))
    log.info("released", { key, current: Math.max(0, current - 1) })
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

  export function reset(): void {
    counts.clear()
    queues.clear()
  }
}
