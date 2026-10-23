import { componentFeatures } from "./features"
import { SessionExecutionOwners } from "@ericsanchezok/synergy-harness/session/execution-owners"
import { AgendaStore } from "./agenda/store"
import { registerAgentContributions } from "./agent-contributions"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerSessionSchema } from "./session-schema"
import { registerAgendaMigrations } from "./agenda/migration"
import { registerAgendaTools } from "./agenda/tools"
import { registerAgendaSessionSignals } from "./agenda/session-signals"
import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { AgendaEvent } from "./agenda/event"
import { Agenda } from "./agenda"
export function agenda(): RuntimeComponent {
  return {
    id: "agenda",
    features: componentFeatures,
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    services: () => ({
      resident: {
        async start() {},
        ready: () => Agenda.start(),
        async stop() {
          Agenda.stop()
        },
      },
    }),
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      SessionExecutionOwners.register("agenda", {
        async allowsSession(session) {
          if (!session.agenda?.itemID) return true
          return !!(await AgendaStore.findInScope(session.scope.id, session.agenda.itemID).catch(() => undefined))
        },
        async allowsMessage(_session, message) {
          const itemID = message.metadata?.agendaItemID
          if (typeof itemID !== "string") return true
          return !!(await AgendaStore.find(itemID).catch(() => undefined))
        },
      })
      registerAgentContributions()
      registerSessionSchema()
      registerAgendaMigrations()
      registerAgendaTools()
      registerAgendaSessionSignals()
      BusEvent.register(...Object.values(AgendaEvent))
    },
  }
}
