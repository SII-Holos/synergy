import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { AgendaTypes } from "./types"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

export namespace AgendaClock {
  const log = Log.create({ service: "agenda.clock" })

  type Handler = (signal: AgendaTypes.FiredSignal, scopeID: string) => Promise<void>

  interface Entry {
    scopeID: string
    nextRunAt: number
  }

  const runtimeState = RuntimeContext.state(() => ({
    entries: new Map<string, Entry>(),
    timer: null as Timer | null,
    handler: null as Handler | null,
    started: false,
  }))

  export function start(onFire: Handler, items: AgendaTypes.Item[]): void {
    const instanceState = runtimeState()

    instanceState.handler = onFire
    for (const item of items) {
      if (item.state.nextRunAt !== undefined) {
        instanceState.entries.set(item.id, { scopeID: item.origin.scope.id, nextRunAt: item.state.nextRunAt })
      }
    }
    instanceState.started = true
    arm()
    log.info("started", { items: instanceState.entries.size })
  }

  export function stop(): void {
    const instanceState = runtimeState()

    if (instanceState.timer !== null) {
      clearTimeout(instanceState.timer)
      instanceState.timer = null
    }
    instanceState.entries.clear()
    instanceState.started = false
    instanceState.handler = null
  }

  export function rearm(scopeID: string, itemID: string, nextRunAt: number | undefined): void {
    const instanceState = runtimeState()

    if (nextRunAt === undefined) {
      instanceState.entries.delete(itemID)
    } else {
      instanceState.entries.set(itemID, { scopeID, nextRunAt })
    }
    if (instanceState.started) arm()
  }

  export function unload(itemID: string): void {
    const instanceState = runtimeState()

    instanceState.entries.delete(itemID)
    if (instanceState.started) arm()
  }

  export function active(): number {
    const instanceState = runtimeState()

    return instanceState.entries.size
  }

  function arm(): void {
    const instanceState = runtimeState()

    if (instanceState.timer !== null) {
      clearTimeout(instanceState.timer)
      instanceState.timer = null
    }

    let nearest: { itemID: string; entry: Entry } | undefined
    for (const [itemID, entry] of instanceState.entries) {
      if (!nearest || entry.nextRunAt < nearest.entry.nextRunAt) {
        nearest = { itemID, entry }
      }
    }

    if (!nearest) return

    const delay = nearest.entry.nextRunAt - Date.now()
    instanceState.timer = setTimeout(fire, delay <= 0 ? 0 : delay)
  }

  function fire(): void {
    const instanceState = runtimeState()

    instanceState.timer = null
    const now = Date.now()
    const fired: Array<{ itemID: string; scopeID: string }> = []

    for (const [itemID, entry] of instanceState.entries) {
      if (entry.nextRunAt <= now) {
        fired.push({ itemID, scopeID: entry.scopeID })
      }
    }

    for (const { itemID, scopeID } of fired) {
      instanceState.entries.delete(itemID)
      const signal: AgendaTypes.FiredSignal = {
        type: "timer",
        source: itemID,
        timestamp: Date.now(),
      }
      if (instanceState.handler) {
        instanceState.handler(signal, scopeID).catch((err) => {
          log.error("handler failed", { itemID, error: err instanceof Error ? err : new Error(String(err)) })
        })
      }
    }

    arm()
  }
}
