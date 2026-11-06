import { componentFeatures } from "./features"
import { AgendaItemOwners } from "@ericsanchezok/synergy-agenda/agenda/item-owners"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerWorkflowsAgents } from "./agents"
import { AnimaSchedule } from "./anima-schedule"
import { registerReload } from "./reload"
import { registerConfig } from "./config-schema"
import { migrations } from "./config-migration"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
export function anima(): RuntimeComponent {
  return {
    id: "anima",
    features: componentFeatures,
    apiVersion: 1,
    version,
    requires: { "local-runtime": version, library: version, note: version, agenda: version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    services: () => ({ resident: { async start() {}, ready: () => AnimaSchedule.seed(), async stop() {} } }),
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      AgendaItemOwners.register("anima")
      registerConfig()
      MigrationRegistry.register("anima", migrations)
      registerWorkflowsAgents()
      registerReload()
    },
  }
}
