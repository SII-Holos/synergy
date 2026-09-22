import { AsyncLocalStorage } from "node:async_hooks"
import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import { withStorageQueueOptions } from "../storage/queue"

export namespace SessionInputProgress {
  export const State = z.enum([
    "accepted",
    "preparing",
    "queued_storage",
    "materializing",
    "running",
    "retrying",
    "completed",
    "cancelled",
    "failed",
  ])
  export const Info = z
    .object({
      sessionID: z.string(),
      messageID: z.string(),
      state: State,
      durable: z.boolean(),
      canonical: z.boolean(),
      updatedAt: z.number(),
      itemID: z.string().optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    })
    .meta({ ref: "SessionInputProgress" })
  export type Info = z.infer<typeof Info>
  export const Event = BusEvent.define("session.input.progress", Info, { streaming: true })
  const state = RuntimeContext.state(() => ({
    active: new Map<string, Info>(),
    failures: new Map<string, { state: "retrying" | "failed"; updatedAt: number; error: NonNullable<Info["error"]> }>(),
  }))

  export function current(sessionID: string, messageID: string) {
    return state().active.get(`${sessionID}:${messageID}`) ?? state().failures.get(sessionID)
  }

  export function clearFailure(sessionID: string) {
    state().failures.delete(sessionID)
  }

  export function schedulingFailure(sessionID: string, error: unknown, terminal: boolean) {
    const failures = state().failures
    if (failures.size >= 1024) failures.delete(failures.keys().next().value!)
    failures.set(sessionID, {
      state: terminal ? "failed" : "retrying",
      updatedAt: Date.now(),
      error: {
        code: error instanceof Error ? error.name : "Error",
        message: "The saved message could not be scheduled. Retry to resume processing.",
      },
    })
  }

  export async function run<T>(
    input: { sessionID: string; messageID: string; itemID: string },
    body: () => Promise<T>,
  ): Promise<T> {
    const active = state().active
    const key = `${input.sessionID}:${input.messageID}`
    let waits = 0
    const publish = AsyncLocalStorage.bind(() => {
      const progress: Info = {
        ...input,
        state: waits > 0 ? "queued_storage" : "materializing",
        durable: true,
        canonical: false,
        updatedAt: Date.now(),
      }
      active.set(key, progress)
      void Bus.publish(Event, progress).catch(() => {})
    })
    publish()
    try {
      return await withStorageQueueOptions(
        {
          onWait: (waiting) => {
            waits += waiting ? 1 : -1
            publish()
          },
        },
        body,
      )
    } finally {
      active.delete(key)
    }
  }
}
