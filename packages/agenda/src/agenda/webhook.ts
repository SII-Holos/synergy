import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { AgendaTypes } from "./types"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

export namespace AgendaWebhook {
  const log = Log.create({ service: "agenda.webhook" })

  type Handler = (signal: AgendaTypes.FiredSignal, scopeID: string) => Promise<void>

  interface Entry {
    itemID: string
    scopeID: string
  }

  const runtimeState = RuntimeContext.state(() => ({
    tokens: new Map<string, Entry>(),
    handler: null as Handler | null,
  }))

  export function start(onFire: Handler, items: AgendaTypes.Item[]): void {
    const instanceState = runtimeState()

    instanceState.handler = onFire
    for (const item of items) {
      register(item.id, item.origin.scope.id, item.triggers)
    }
    log.info("started", { tokens: instanceState.tokens.size })
  }

  export function stop(): void {
    const instanceState = runtimeState()

    instanceState.tokens.clear()
    instanceState.handler = null
  }

  export function register(itemID: string, scopeID: string, triggers: AgendaTypes.Trigger[]): void {
    const instanceState = runtimeState()

    for (const trigger of triggers) {
      if (trigger.type !== "webhook" || !trigger.token) continue
      instanceState.tokens.set(trigger.token, { itemID, scopeID })
    }
  }

  export function unregister(itemID: string): void {
    const instanceState = runtimeState()

    for (const [token, entry] of instanceState.tokens) {
      if (entry.itemID === itemID) instanceState.tokens.delete(token)
    }
  }

  export function lookup(token: string): Entry | undefined {
    const instanceState = runtimeState()

    return instanceState.tokens.get(token)
  }

  export async function fire(token: string, payload: Record<string, unknown>): Promise<boolean> {
    const instanceState = runtimeState()

    const entry = instanceState.tokens.get(token)
    if (!entry || !instanceState.handler) return false

    const signal: AgendaTypes.FiredSignal = {
      type: "webhook",
      source: entry.itemID,
      payload,
      timestamp: Date.now(),
    }

    instanceState.handler(signal, entry.scopeID).catch((err) => {
      log.error("webhook handler failed", {
        itemID: entry.itemID,
        error: err instanceof Error ? err : new Error(String(err)),
      })
    })

    return true
  }

  export function active(): number {
    const instanceState = runtimeState()

    return instanceState.tokens.size
  }
}
