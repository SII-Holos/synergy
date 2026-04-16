import { AgendaTypes } from "./types"
import { Log } from "../util/log"

export namespace AgendaClock {
  const log = Log.create({ service: "agenda.clock" })

  type Handler = (signal: AgendaTypes.FiredSignal, scopeID: string) => Promise<void>

  interface Entry {
    scopeID: string
    nextRunAt: number
  }

  const entries = new Map<string, Entry>()
  let timer: Timer | null = null
  let handler: Handler | null = null
  let started = false

  export function start(onFire: Handler, items: AgendaTypes.Item[]): void {
    handler = onFire
    for (const item of items) {
      if (item.state.nextRunAt !== undefined) {
        entries.set(item.id, { scopeID: item.origin.scope.id, nextRunAt: item.state.nextRunAt })
      }
    }
    started = true
    arm()
    log.info("started", { items: entries.size })
  }

  export function stop(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    entries.clear()
    started = false
    handler = null
  }

  export function rearm(scopeID: string, itemID: string, nextRunAt: number | undefined): void {
    if (nextRunAt === undefined) {
      entries.delete(itemID)
    } else {
      entries.set(itemID, { scopeID, nextRunAt })
    }
    if (started) arm()
  }

  export function unload(itemID: string): void {
    entries.delete(itemID)
    if (started) arm()
  }

  export function active(): number {
    return entries.size
  }

  function arm(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }

    let nearest: { itemID: string; entry: Entry } | undefined
    for (const [itemID, entry] of entries) {
      if (!nearest || entry.nextRunAt < nearest.entry.nextRunAt) {
        nearest = { itemID, entry }
      }
    }

    if (!nearest) return

    const delay = nearest.entry.nextRunAt - Date.now()
    timer = setTimeout(fire, delay <= 0 ? 0 : delay)
  }

  function fire(): void {
    timer = null
    const now = Date.now()
    const fired: Array<{ itemID: string; scopeID: string }> = []

    for (const [itemID, entry] of entries) {
      if (entry.nextRunAt <= now) {
        fired.push({ itemID, scopeID: entry.scopeID })
      }
    }

    for (const { itemID, scopeID } of fired) {
      entries.delete(itemID)
      const signal: AgendaTypes.FiredSignal = {
        type: "timer",
        source: itemID,
        timestamp: Date.now(),
      }
      if (handler) {
        handler(signal, scopeID).catch((err) => {
          log.error("handler failed", { itemID, error: err instanceof Error ? err : new Error(String(err)) })
        })
      }
    }

    arm()
  }
}
