import { componentFeatures } from "./features"
import { AgendaItemOwners } from "@ericsanchezok/synergy-agenda/agenda/item-owners"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerConfig } from "./config-schema"
import { registerMaintenance } from "./maintenance"
import { registerSessions } from "./session/register"
import { registerBossDomain } from "./boss/register"
import { registerAgents } from "./agents"
import { registerReload } from "./reload"
export function boss(): RuntimeComponent {
  return {
    id: "boss",
    features: componentFeatures,
    apiVersion: 1,
    version,
    requires: { "local-runtime": version, library: version, agenda: version },
    maintenance: new URL("./maintenance.ts", import.meta.url),
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      AgendaItemOwners.register("boss")
      registerConfig()
      registerMaintenance()
      registerSessions()
      registerBossDomain()
      registerAgents()
      registerReload()
    },
  }
}
