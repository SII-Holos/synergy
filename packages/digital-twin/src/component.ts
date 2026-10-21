import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { registerConfig } from "./config-schema"
import { registerAgents } from "./agents"
import { DigitalTwin } from "./service"
import { version } from "../package.json" with { type: "json" }

const state = RuntimeContext.state(() => ({ registered: false }))
const migrations = [
  {
    id: "20261021-reference-projection-v1",
    scope: "global" as const,
    execution: "startup" as const,
    description: "Version the Digital Twin projection and defer history preparation until use",
    async up() {
      await Storage.write(StoragePath.digitalTwinCursor(), { version: 1, complete: false })
    },
  },
  {
    id: "20261021-reference-projection-v2",
    scope: "global" as const,
    execution: "startup" as const,
    description: "Rebuild family projections with ranked lexical preparation on first use",
    async up() {
      await Storage.write(StoragePath.digitalTwinCursor(), { version: 2, complete: false })
    },
  },
]
export function digitalTwin(): RuntimeComponent {
  return {
    id: "digital-twin",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    configKeys: ["digitalTwin"],
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    adapters: { http: new URL("./http.ts", import.meta.url) },
    services: () => ({ disposeExtensions: DigitalTwin.close }),
    register() {
      if (state().registered) return
      RuntimeContext.assertCompositionOpen("Digital Twin")
      registerConfig()
      registerAgents()
      MigrationRegistry.register("digital-twin", migrations)
      state().registered = true
    },
  }
}
