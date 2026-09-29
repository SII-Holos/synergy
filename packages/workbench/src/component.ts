import { registerProjectMigrations } from "./project/migration"
import { PushBridge } from "./push/bridge"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerWorkbenchAgents } from "./agents"
import { registerProjectTools } from "./project/tools"
import { registerProjectStartup } from "./project/startup"
import { registerProjectSessionHealth } from "./project/session-health"
import { registerConfig } from "./config-schema"
import { Usage } from "@ericsanchezok/synergy-harness/usage"

export function workbench(): RuntimeComponent {
  return {
    id: "workbench",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    services() {
      let dispose: (() => void) | undefined
      let stopUsage: (() => Promise<void>) | undefined
      return {
        resident: {
          async start() {
            dispose = PushBridge.init()
            stopUsage = Usage.service()
          },
          async stop() {
            await stopUsage?.()
            stopUsage = undefined
            dispose?.()
            dispose = undefined
            await PushBridge.flush()
          },
        },
      }
    },
    adapters: { cli: new URL("./cli-adapter.ts", import.meta.url), http: new URL("./http.ts", import.meta.url) },
    register() {
      registerConfig()
      registerProjectMigrations()
      registerWorkbenchAgents()
      registerProjectTools()
      registerProjectStartup()
      registerProjectSessionHealth()
    },
  }
}
