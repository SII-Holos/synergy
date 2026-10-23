import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { Vcs } from "./project/vcs"
import { Ide } from "./project/ide"
import { ReviewState } from "./review/state"
import { ExecutionSchema } from "./execution/schema"
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
import { ExecutionService } from "./execution/service"
import { WorkbenchPresentation } from "./presentation/service"
import { registerPresentationTools } from "./presentation/tools"

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
      let stopExecution: (() => void) | undefined
      let stopPresentation: (() => void) | undefined
      return {
        resident: {
          async start() {
            dispose = PushBridge.init()
            stopUsage = Usage.service()
            stopExecution = ExecutionService.init()
            stopPresentation = WorkbenchPresentation.init()
          },
          async stop() {
            stopPresentation?.()
            stopPresentation = undefined
            await stopUsage?.()
            stopExecution?.()
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
      BusEvent.register(
        ...Object.values(Vcs.Event),
        ...Object.values(Ide.Event),
        ReviewState.Updated,
        ExecutionSchema.Updated,
        ExecutionSchema.ProjectionUpdated,
      )
      registerConfig()
      registerProjectMigrations()
      registerWorkbenchAgents()
      registerProjectTools()
      registerPresentationTools()
      registerProjectStartup()
      registerProjectSessionHealth()
    },
  }
}
