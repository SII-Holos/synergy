import { AgendaClock } from "./clock"
import { AgendaReactor } from "./reactor"
import { AgendaStore } from "./store"
import { AgendaWatcher } from "./watcher"
import { AgendaWebhook } from "./webhook"
import { AgendaTypes } from "./types"
import { Log } from "../util/log"

export { AgendaTypes } from "./types"
export { AgendaEvent } from "./event"
export { AgendaStore } from "./store"
export { AgendaClock } from "./clock"
export { AgendaReactor } from "./reactor"
export { AgendaDelivery } from "./delivery"
export { AgendaWatcher } from "./watcher"
export { AgendaWebhook } from "./webhook"
export { AgendaBootstrap } from "./bootstrap"

const log = Log.create({ service: "agenda" })

export namespace Agenda {
  const inflight = new Set<string>()

  export async function start(): Promise<void> {
    const handler = async (signal: AgendaTypes.FiredSignal, scopeID: string) => {
      const itemID = signal.source
      if (inflight.has(itemID)) {
        log.info("skipped (already running)", { itemID, signalType: signal.type })
        return
      }
      inflight.add(itemID)
      try {
        const result = await AgendaReactor.execute(signal, scopeID)
        if (result.deactivated) {
          teardownItem(itemID)
        } else {
          AgendaClock.rearm(scopeID, itemID, result.nextRunAt)
        }
      } finally {
        inflight.delete(itemID)
      }
    }
    const items = await AgendaStore.loadActive()
    AgendaClock.start(handler, items)
    AgendaWatcher.start(handler, items)
    AgendaWebhook.start(handler, items)
    log.info("agenda started", {
      clock: AgendaClock.active(),
      watcher: AgendaWatcher.active(),
      webhooks: AgendaWebhook.active(),
    })
  }

  export function stop(): void {
    AgendaClock.stop()
    AgendaWatcher.stop()
    AgendaWebhook.stop()
    inflight.clear()
    log.info("agenda stopped")
  }

  export async function create(input: Parameters<typeof AgendaStore.create>[0]) {
    const item = await AgendaStore.create(input)
    if (item.status === "active") {
      syncItem(item.origin.scope.id, item)
    }
    return item
  }

  export async function update(itemID: string, patch: Parameters<typeof AgendaStore.update>[2], scopeID?: string) {
    const resolved = scopeID ? await AgendaStore.findInScope(scopeID, itemID) : await AgendaStore.find(itemID)
    const item = await AgendaStore.update(resolved.scopeID, itemID, patch)
    if (item.status === "active") {
      syncItem(resolved.scopeID, item)
    } else {
      teardownItem(item.id)
    }
    return item
  }

  export async function remove(itemID: string, scopeID?: string) {
    const resolved = scopeID ? await AgendaStore.findInScope(scopeID, itemID) : await AgendaStore.find(itemID)
    teardownItem(itemID)
    await AgendaStore.remove(resolved.scopeID, itemID)
  }

  export async function trigger(itemID: string) {
    const { item, scopeID } = await AgendaStore.find(itemID)
    if (item.status === "pending" || item.status === "paused") {
      await AgendaStore.update(scopeID, itemID, { status: "active" })
      syncItem(scopeID, item)
    }
    const signal: AgendaTypes.FiredSignal = {
      type: "manual",
      source: itemID,
      timestamp: Date.now(),
    }
    if (inflight.has(itemID)) {
      log.info("skipped (already running)", { itemID, signalType: signal.type })
      return { sessionID: undefined }
    }
    inflight.add(itemID)
    AgendaReactor.execute(signal, scopeID)
      .then((result) => {
        // Always rearm — even if nextRunAt is undefined, the clock entry
        // should be cleared. For recurring triggers the reactor already
        // computes a valid nextRunAt.
        AgendaClock.rearm(scopeID, itemID, result.nextRunAt)
      })
      .catch((err) => {
        log.error("manual trigger failed", { itemID, error: err instanceof Error ? err : new Error(String(err)) })
      })
      .finally(() => {
        inflight.delete(itemID)
      })
    return { sessionID: undefined }
  }

  export async function activate(itemID: string, options?: { recomputeNextRunAt?: boolean }) {
    const { scopeID } = await AgendaStore.find(itemID)
    const item = await AgendaStore.update(scopeID, itemID, { status: "active" }, options)
    syncItem(scopeID, item)
    return item
  }

  export async function pause(itemID: string) {
    return deactivate(itemID, "paused")
  }

  export async function complete(itemID: string) {
    return deactivate(itemID, "done")
  }

  export async function cancel(itemID: string) {
    return deactivate(itemID, "cancelled")
  }

  async function deactivate(itemID: string, status: AgendaTypes.ItemStatus) {
    const { scopeID } = await AgendaStore.find(itemID)
    const item = await AgendaStore.update(scopeID, itemID, { status })
    teardownItem(item.id)
    return item
  }

  function syncItem(scopeID: string, item: AgendaTypes.Item): void {
    if (item.state.nextRunAt !== undefined) {
      AgendaClock.rearm(scopeID, item.id, item.state.nextRunAt)
    } else {
      AgendaClock.unload(item.id)
    }
    AgendaWatcher.unregister(item.id)
    AgendaWatcher.register(item.id, scopeID, item.triggers)
    AgendaWebhook.unregister(item.id)
    AgendaWebhook.register(item.id, scopeID, item.triggers)
  }

  function teardownItem(itemID: string): void {
    AgendaClock.unload(itemID)
    AgendaWatcher.unregister(itemID)
    AgendaWebhook.unregister(itemID)
  }
}
