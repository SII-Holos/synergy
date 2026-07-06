import z from "zod"
import { Log } from "../util/log"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { BusEvent } from "./bus-event"
import { GlobalBus } from "./global"
import { SyncSequencer } from "./sequencer"

export namespace Bus {
  const log = Log.create({ service: "bus" })
  type Subscription = (event: any) => void

  export const ScopeRuntimeDisposed = BusEvent.define(
    "scope.runtime.disposed",
    z.object({
      scopeID: z.string(),
      directory: z.string().optional(),
    }),
  )

  const state = ScopedState.create(
    () => {
      const subscriptions = new Map<any, Subscription[]>()
      // Per scope-runtime: a fresh epoch (so a client that reconnects across a
      // runtime restart is told to resync) and a monotonic sequencer + journal.
      const sequencer = new SyncSequencer(crypto.randomUUID())

      return {
        subscriptions,
        sequencer,
      }
    },
    async (entry) => {
      const wildcard = entry.subscriptions.get("*")
      if (!wildcard) return
      const event = {
        type: ScopeRuntimeDisposed.type,
        properties: {
          scopeID: ScopeContext.current.scope.id,
          directory: ScopeContext.current.directory,
        },
      }
      for (const sub of [...wildcard]) {
        sub(event)
      }
    },
  )

  export async function publish<Definition extends BusEvent.Definition>(
    def: Definition,
    properties: z.output<Definition["properties"]>,
  ) {
    const payload: {
      type: string
      properties: unknown
      seq?: number
      epoch?: string
      streaming?: boolean
    } = {
      type: def.type,
      properties,
    }
    // Stamp state events with a scope-monotonic seq + epoch so the client can
    // detect gaps, replay, and reject stale snapshots. Streaming events (part
    // deltas) are intentionally left unsequenced.
    const sequencer = state().sequencer
    if (def.streaming) {
      payload.streaming = true
    } else {
      payload.epoch = sequencer.epoch
      sequencer.stamp(payload as { seq: number }, Date.now())
    }
    log.debug("publishing", {
      type: def.type,
    })
    const pending: Promise<void>[] = []
    for (const key of [def.type, "*"]) {
      const match = state().subscriptions.get(key)
      for (const sub of match ?? []) {
        pending.push(
          Promise.resolve()
            .then(() => sub(payload))
            .catch((err) => {
              log.error("subscriber threw during publish", {
                type: def.type,
                error: err,
              })
            }),
        )
      }
    }
    GlobalBus.emit("event", {
      // Route UI/session events to the scope directory, not the execution cwd.
      // A session may execute from a worktree workspace while still belonging to
      // the original scope store that the frontend subscribed to.
      directory: ScopeContext.current.scope.type === "home" ? "home" : ScopeContext.current.scope.directory,
      payload,
    })
    await Promise.all(pending)
  }

  export function subscribe<Definition extends BusEvent.Definition>(
    def: Definition,
    callback: (event: { type: Definition["type"]; properties: z.infer<Definition["properties"]> }) => void,
  ) {
    return raw(def.type, callback)
  }

  export function once<Definition extends BusEvent.Definition>(
    def: Definition,
    callback: (event: {
      type: Definition["type"]
      properties: z.infer<Definition["properties"]>
    }) => "done" | undefined,
  ) {
    const unsub = subscribe(def, (event) => {
      if (callback(event)) unsub()
    })
  }

  export function subscribeAll(callback: (event: any) => void) {
    return raw("*", callback)
  }

  /** Current scope's event epoch (identifies this runtime instance). */
  export function epoch() {
    return state().sequencer.epoch
  }

  /** Highest state-event seq published in the current scope. */
  export function currentSeq() {
    return state().sequencer.current
  }

  /** Replay state events after `sinceSeq` for the current scope (see SyncSequencer). */
  export function replay(sinceSeq: number) {
    return state().sequencer.replay(sinceSeq, Date.now())
  }

  function raw(type: string, callback: (event: any) => void) {
    log.debug("subscribing", { type })
    const subscriptions = state().subscriptions
    let match = subscriptions.get(type) ?? []
    match.push(callback)
    subscriptions.set(type, match)

    return () => {
      log.debug("unsubscribing", { type })
      const match = subscriptions.get(type)
      if (!match) return
      const index = match.indexOf(callback)
      if (index === -1) return
      match.splice(index, 1)
    }
  }
}
