import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { SessionEvent } from "@ericsanchezok/synergy-harness/session/event"
import { AgendaTypes } from "./types"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

/**
 * Session-event agenda trigger — fires agenda items when a watched session
 * starts or ends a turn.
 *
 * Mirrors AgendaWatcher's structure: registrations are keyed by watched
 * session, and events arriving on the global Bus are matched against the
 * optional agent/finish filters before being forwarded to the shared Agenda
 * handler as a FiredSignal.
 *
 * The subscription is global (subscribeGlobal) because the agenda item and
 * the watched session may live in different scopes — e.g. a boss session in
 * one scope watching a research session in another.
 */
export namespace AgendaSessionTrigger {
  const log = Log.create({ service: "agenda.session-trigger" })

  type Handler = (signal: AgendaTypes.FiredSignal, scopeID: string) => Promise<void>

  interface Entry {
    itemID: string
    scopeID: string
    sessionID: string
    event: "turn.start" | "turn.end"
    agent?: string
    finish?: string
  }

  /** Watched sessionID → registered entries. */
  const runtimeState = RuntimeContext.state(() => ({
    bySession: new Map<string, Entry[]>(),
    lastFiredMessage: new Map<string, string>(),
    handler: null as Handler | null,
    unsubscribers: [] as Array<() => void>,
    started: false,
  }))

  /** Entry fingerprint (itemID + event + filters) → last fired messageID.
   *  Dedup is per entry, not per item, so multiple session triggers on the
   *  same item (e.g. turn.start + turn.end) can each fire independently. */

  export function start(onFire: Handler, items: AgendaTypes.Item[]): void {
    const instanceState = runtimeState()

    instanceState.handler = onFire
    for (const item of items) {
      register(item.id, item.origin.scope.id, item.triggers)
    }
    instanceState.unsubscribers = [
      Bus.subscribeGlobal(SessionEvent.TurnStart, (event) => handleEvent("turn.start", event.properties)),
      Bus.subscribeGlobal(SessionEvent.TurnEnd, (event) => handleEvent("turn.end", event.properties)),
    ]
    instanceState.started = true
    log.info("started", { sessions: instanceState.bySession.size, entries: countEntries() })
  }

  export function stop(): void {
    const instanceState = runtimeState()

    instanceState.bySession.clear()
    instanceState.lastFiredMessage.clear()
    for (const unsub of instanceState.unsubscribers) unsub()
    instanceState.unsubscribers = []
    instanceState.started = false
    instanceState.handler = null
  }

  export function register(itemID: string, scopeID: string, triggers: AgendaTypes.Trigger[]): void {
    const instanceState = runtimeState()

    unregister(itemID)
    for (const trigger of triggers) {
      if (trigger.type !== "session") continue
      const entry: Entry = {
        itemID,
        scopeID,
        sessionID: trigger.sessionID,
        event: trigger.event ?? "turn.end",
        agent: trigger.agent,
        finish: trigger.finish,
      }
      const list = instanceState.bySession.get(entry.sessionID) ?? []
      list.push(entry)
      instanceState.bySession.set(entry.sessionID, list)
    }
  }

  export function unregister(itemID: string): void {
    const instanceState = runtimeState()

    for (const [sessionID, list] of instanceState.bySession) {
      const filtered = list.filter((entry) => entry.itemID !== itemID)
      if (filtered.length === 0) instanceState.bySession.delete(sessionID)
      else instanceState.bySession.set(sessionID, filtered)
    }
    for (const key of instanceState.lastFiredMessage.keys()) {
      if (key.startsWith(`${itemID}:`)) instanceState.lastFiredMessage.delete(key)
    }
  }

  export function active(): { sessions: number; entries: number } {
    const instanceState = runtimeState()

    return { sessions: instanceState.bySession.size, entries: countEntries() }
  }

  function countEntries(): number {
    const instanceState = runtimeState()

    let n = 0
    for (const list of instanceState.bySession.values()) n += list.length
    return n
  }

  function handleEvent(
    event: "turn.start" | "turn.end",
    props: { sessionID: string; messageID: string; finish?: string; agent?: string },
  ): void {
    const instanceState = runtimeState()

    if (!instanceState.started) return
    const entries = instanceState.bySession.get(props.sessionID)
    if (!entries || entries.length === 0) return
    for (const entry of entries) {
      if (entry.event !== event) continue
      if (entry.agent !== undefined && entry.agent !== props.agent) continue
      if (entry.finish !== undefined && entry.finish !== props.finish) continue
      fire(entry, props)
    }
  }

  function fire(entry: Entry, props: { sessionID: string; messageID: string; finish?: string; agent?: string }): void {
    const instanceState = runtimeState()

    const dedupKey = `${entry.itemID}:${entry.event}:${entry.agent ?? ""}:${entry.finish ?? ""}`
    if (instanceState.lastFiredMessage.get(dedupKey) === props.messageID) return
    instanceState.lastFiredMessage.set(dedupKey, props.messageID)
    if (!instanceState.handler) return

    const signal: AgendaTypes.FiredSignal = {
      type: "session",
      source: entry.itemID,
      payload: {
        sessionID: props.sessionID,
        messageID: props.messageID,
        finish: props.finish,
        agent: props.agent,
      },
      timestamp: Date.now(),
    }
    instanceState.handler(signal, entry.scopeID).catch((err) => {
      log.error("session trigger handler failed", {
        itemID: entry.itemID,
        error: err instanceof Error ? err : new Error(String(err)),
      })
    })
  }
}
