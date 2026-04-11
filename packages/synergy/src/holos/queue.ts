import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Storage } from "@/storage/storage"
import { StoragePath } from "@/storage/path"
import { Log } from "@/util/log"
import { HolosProtocol } from "./protocol"

const log = Log.create({ service: "holos.queue" })

export namespace MessageQueue {
  export const Status = z.enum(["pending", "sending", "delivered", "expired", "failed"])
  export type Status = z.infer<typeof Status>

  export const Info = z.object({
    id: z.string(),
    targetAgentId: z.string(),
    event: z.string(),
    payload: z.unknown(),
    status: Status.default("pending"),
    createdAt: z.number(),
    expiresAt: z.number(),
    retryCount: z.number().default(0),
    lastRetryAt: z.number().optional(),
    wsRequestId: z.string().optional(),
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Enqueued: BusEvent.define("holos.queue.enqueued", z.object({ item: Info })),
    Delivered: BusEvent.define("holos.queue.delivered", z.object({ id: z.string() })),
    Expired: BusEvent.define("holos.queue.expired", z.object({ id: z.string() })),
  }

  export async function enqueue(input: {
    targetAgentId: string
    event: string
    payload: unknown
    expiresIn?: number
  }): Promise<Info> {
    const expiresIn = input.expiresIn ?? HolosProtocol.QueueExpiry[input.event] ?? HolosProtocol.DEFAULT_QUEUE_EXPIRY
    const id = `mq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const item: Info = {
      id,
      targetAgentId: input.targetAgentId,
      event: input.event,
      payload: input.payload,
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + expiresIn,
      retryCount: 0,
    }
    await Storage.write(StoragePath.holosMessageQueueItem(id), item)
    await Bus.publish(Event.Enqueued, { item })
    log.info("message enqueued", { id, target: input.targetAgentId, event: input.event })
    return item
  }

  export async function list(): Promise<Info[]> {
    const keys = await Storage.list(StoragePath.holosMessageQueueRoot())
    const items: Info[] = []
    for (const key of keys) {
      try {
        const item = await Storage.read<Info>(key)
        if (item) items.push(item)
      } catch {
        continue
      }
    }
    return items
  }

  export async function get(id: string): Promise<Info | undefined> {
    try {
      return await Storage.read<Info>(StoragePath.holosMessageQueueItem(id))
    } catch {
      return undefined
    }
  }

  export async function listByTarget(targetAgentId: string): Promise<Info[]> {
    const all = await list()
    return all.filter((item) => item.targetAgentId === targetAgentId)
  }

  export async function markSending(id: string, wsRequestId: string): Promise<void> {
    const item = await get(id)
    if (!item) return
    await Storage.write(StoragePath.holosMessageQueueItem(id), {
      ...item,
      status: "sending",
      wsRequestId,
      lastRetryAt: Date.now(),
      retryCount: item.retryCount + 1,
    })
  }

  export async function markDelivered(id: string): Promise<void> {
    await Storage.remove(StoragePath.holosMessageQueueItem(id))
    await Bus.publish(Event.Delivered, { id })
    log.debug("message delivered, removed from queue", { id })
  }

  export async function markFailed(id: string): Promise<void> {
    const item = await get(id)
    if (!item) return
    await Storage.write(StoragePath.holosMessageQueueItem(id), {
      ...item,
      status: "failed",
      wsRequestId: undefined,
    })
  }

  export async function remove(id: string): Promise<void> {
    await Storage.remove(StoragePath.holosMessageQueueItem(id))
  }

  export async function cleanExpired(): Promise<number> {
    const items = await list()
    const now = Date.now()
    let count = 0
    for (const item of items) {
      if (now >= item.expiresAt || item.status === "failed") {
        await Storage.remove(StoragePath.holosMessageQueueItem(item.id))
        await Bus.publish(Event.Expired, { id: item.id })
        count++
      }
    }
    if (count > 0) log.info("cleaned expired queue items", { count })
    return count
  }

  const DEFAULT_RETRY_INTERVAL_MS = 30_000
  const MAX_RETRY_COUNT = 20
  const PROBE_WAIT_MS = 6_000

  export function startRetryLoop(input: {
    sendFn: (item: Info) => Promise<string>
    probeFn: (agentId: string) => void
    isOnline: (agentId: string) => boolean
    intervalMs?: number
  }): { stop: () => void } {
    const intervalMs = input.intervalMs ?? DEFAULT_RETRY_INTERVAL_MS

    const tick = async () => {
      try {
        await cleanExpired()
        const items = await list()
        const pending = items.filter((item) => item.status === "pending")
        if (pending.length === 0) return

        const byTarget = new Map<string, Info[]>()
        for (const item of pending) {
          const existing = byTarget.get(item.targetAgentId) ?? []
          existing.push(item)
          byTarget.set(item.targetAgentId, existing)
        }

        for (const targetId of byTarget.keys()) {
          input.probeFn(targetId)
        }

        await new Promise((resolve) => setTimeout(resolve, PROBE_WAIT_MS))

        for (const [targetId, targetItems] of byTarget) {
          if (!input.isOnline(targetId)) continue

          for (const item of targetItems) {
            if (item.retryCount >= MAX_RETRY_COUNT) {
              log.warn("max retry count exceeded, marking failed", { id: item.id, target: targetId })
              await markFailed(item.id)
              continue
            }
            try {
              const wsRequestId = await input.sendFn(item)
              await markSending(item.id, wsRequestId)
            } catch (err) {
              log.warn("retry send failed", {
                id: item.id,
                target: targetId,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }
        }
      } catch (err) {
        log.warn("retry loop tick failed", { error: err instanceof Error ? err.message : String(err) })
      }
    }

    const timer = setInterval(tick, intervalMs)

    return {
      stop: () => clearInterval(timer),
    }
  }
}
