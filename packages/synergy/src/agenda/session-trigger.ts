import { Bus } from "../bus"
import { SessionEvent } from "../session/event"
import { AgendaTypes } from "./types"
import { Log } from "../util/log"

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
  const bySession = new Map<string, Entry[]>()

  /** entry 指纹（itemID + event + filters）→ last fired messageID。
   *  按条目而不是按 itemID 去重，使同一 item 的多个 session trigger
   *  （如 turn.start 与 turn.end 并存）都能独立触发。 */
  const lastFiredMessage = new Map<string, string>()
  let handler: Handler | null = null
  let unsubscribers: Array<() => void> = []
  let started = false

  export function start(onFire: Handler, items: AgendaTypes.Item[]): void {
    handler = onFire
    for (const item of items) {
      register(item.id, item.origin.scope.id, item.triggers)
    }
    unsubscribers = [
      Bus.subscribeGlobal(SessionEvent.TurnStart, (event) => handleEvent("turn.start", event.properties)),
      Bus.subscribeGlobal(SessionEvent.TurnEnd, (event) => handleEvent("turn.end", event.properties)),
    ]
    started = true
    log.info("started", { sessions: bySession.size, entries: countEntries() })
  }

  export function stop(): void {
    bySession.clear()
    lastFiredMessage.clear()
    for (const unsub of unsubscribers) unsub()
    unsubscribers = []
    started = false
    handler = null
  }

  export function register(itemID: string, scopeID: string, triggers: AgendaTypes.Trigger[]): void {
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
      const list = bySession.get(entry.sessionID) ?? []
      list.push(entry)
      bySession.set(entry.sessionID, list)
    }
  }

  export function unregister(itemID: string): void {
    for (const [sessionID, list] of bySession) {
      const filtered = list.filter((entry) => entry.itemID !== itemID)
      if (filtered.length === 0) bySession.delete(sessionID)
      else bySession.set(sessionID, filtered)
    }
    for (const key of lastFiredMessage.keys()) {
      if (key.startsWith(`${itemID}:`)) lastFiredMessage.delete(key)
    }
  }

  export function active(): { sessions: number; entries: number } {
    return { sessions: bySession.size, entries: countEntries() }
  }

  function countEntries(): number {
    let n = 0
    for (const list of bySession.values()) n += list.length
    return n
  }

  function handleEvent(
    event: "turn.start" | "turn.end",
    props: { sessionID: string; messageID: string; finish?: string; agent?: string },
  ): void {
    if (!started) return
    const entries = bySession.get(props.sessionID)
    if (!entries || entries.length === 0) return
    for (const entry of entries) {
      if (entry.event !== event) continue
      if (entry.agent !== undefined && entry.agent !== props.agent) continue
      if (entry.finish !== undefined && entry.finish !== props.finish) continue
      fire(entry, props)
    }
  }

  function fire(entry: Entry, props: { sessionID: string; messageID: string; finish?: string; agent?: string }): void {
    const dedupKey = `${entry.itemID}:${entry.event}:${entry.agent ?? ""}:${entry.finish ?? ""}`
    if (lastFiredMessage.get(dedupKey) === props.messageID) return
    lastFiredMessage.set(dedupKey, props.messageID)
    if (!handler) return

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
    handler(signal, entry.scopeID).catch((err) => {
      log.error("session trigger handler failed", {
        itemID: entry.itemID,
        error: err instanceof Error ? err : new Error(String(err)),
      })
    })
  }
}
