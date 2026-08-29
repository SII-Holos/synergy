import { SessionAgendaSignals } from "../session/agenda-signals"
import { AgendaStore } from "./store"
import { AgendaSessionWakeup } from "./session-wakeup"

/**
 * S9c source inversion: the L1 session domain observes agenda wake-ups
 * (upcoming reminder rendering, continuation blockers) through the
 * SessionAgendaSignals registry instead of importing the agenda product
 * domain. Loaded through src/product-registration.ts.
 */
export function registerAgendaSessionSignals() {
  SessionAgendaSignals.register({
    upcomingWakeups: async (scopeID, sessionID) => {
      const items = await AgendaStore.listForScope(scopeID)
      return items.map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        wake: item.wake,
        originSessionID: item.origin.sessionID ?? "",
        nextRunAt: item.state.nextRunAt,
      }))
    },
    sessionBlockers: async (sessionID, scopeID) => {
      const response = await AgendaSessionWakeup.list(sessionID, scopeID)
      return response.items.map((item) => ({ id: item.itemID, description: item.title }))
    },
  })
}
