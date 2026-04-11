import { AgendaTypes } from "./types"
import { Log } from "../util/log"

export namespace AgendaWebhook {
  const log = Log.create({ service: "agenda.webhook" })

  type Handler = (signal: AgendaTypes.FiredSignal, scopeID: string) => Promise<void>

  interface Entry {
    itemID: string
    scopeID: string
  }

  const tokens = new Map<string, Entry>()
  let handler: Handler | null = null

  export function start(onFire: Handler, items: AgendaTypes.Item[]): void {
    handler = onFire
    for (const item of items) {
      register(item.id, item.origin.scope.id, item.triggers)
    }
    log.info("started", { tokens: tokens.size })
  }

  export function stop(): void {
    tokens.clear()
    handler = null
  }

  export function register(itemID: string, scopeID: string, triggers: AgendaTypes.Trigger[]): void {
    for (const trigger of triggers) {
      if (trigger.type !== "webhook" || !trigger.token) continue
      tokens.set(trigger.token, { itemID, scopeID })
    }
  }

  export function unregister(itemID: string): void {
    for (const [token, entry] of tokens) {
      if (entry.itemID === itemID) tokens.delete(token)
    }
  }

  export function lookup(token: string): Entry | undefined {
    return tokens.get(token)
  }

  export async function fire(token: string, payload: Record<string, unknown>): Promise<boolean> {
    const entry = tokens.get(token)
    if (!entry || !handler) return false

    const signal: AgendaTypes.FiredSignal = {
      type: "webhook",
      source: entry.itemID,
      payload,
      timestamp: Date.now(),
    }

    handler(signal, entry.scopeID).catch((err) => {
      log.error("webhook handler failed", {
        itemID: entry.itemID,
        error: err instanceof Error ? err : new Error(String(err)),
      })
    })

    return true
  }

  export function active(): number {
    return tokens.size
  }
}
