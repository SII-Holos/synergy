import { componentFeatures } from "./features"
import { AgendaItemOwners } from "@ericsanchezok/synergy-agenda/agenda/item-owners"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerConfig } from "./config-schema"
import { registerSessionSchema } from "./session-schema"
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
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      AgendaItemOwners.register("boss")
      registerConfig()
      registerSessionSchema()
      registerSessions()
      registerBossDomain()
      registerAgents()
      registerReload()
    },
  }
}
