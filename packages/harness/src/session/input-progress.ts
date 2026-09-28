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
  type Failure = {
    sessionID: string
    messageID: string
    itemID: string
    state: "retrying" | "failed"
    updatedAt: number
    error: NonNullable<Info["error"]>
    cause: unknown
  }
  const state = RuntimeContext.state(() => ({
    active: new Map<string, Info>(),
    failures: new Map<string, Failure>(),
  }))

  export function current(sessionID: string, messageID: string) {
    const key = `${sessionID}:${messageID}`
    return state().active.get(key) ?? state().failures.get(key)
  }

  export function clearFailure(sessionID: string) {
    for (const [key, failure] of state().failures) if (failure.sessionID === sessionID) state().failures.delete(key)
  }

  function recordFailure(input: { sessionID: string; messageID: string; itemID: string }, cause: unknown) {
    const failures = state().failures
    if (failures.size >= 1024) failures.delete(failures.keys().next().value!)
    const failure: Failure = {
      ...input,
      state: "retrying",
      updatedAt: Date.now(),
      cause,
      error: {
        code: cause instanceof Error ? cause.name : "Error",
        message: "The saved message could not be scheduled. Retry to resume processing.",
      },
    }
    failures.set(`${input.sessionID}:${input.messageID}`, failure)
    return failure
  }

  export function schedulingFailure(
    sessionID: string,
    error: unknown,
    terminal: boolean,
    input?: { messageID: string; itemID: string },
  ) {
    const failure = input
      ? recordFailure({ sessionID, ...input }, error)
      : [...state().failures.values()].find((value) => value.sessionID === sessionID && value.cause === error)
    if (!failure) return
    failure.state = terminal ? "failed" : "retrying"
    failure.updatedAt = Date.now()
    return { messageID: failure.messageID, itemID: failure.itemID }
  }

  export async function run<T>(
    input: { sessionID: string; messageID: string; itemID: string },
    body: () => Promise<T>,
  ): Promise<T> {
    const active = state().active
    const key = `${input.sessionID}:${input.messageID}`
    state().failures.delete(key)
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
    } catch (cause) {
      recordFailure(input, cause)
      throw cause
    } finally {
      active.delete(key)
    }
  }
}
