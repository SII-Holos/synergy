import { componentFeatures } from "./features"
import { registerMaintenance } from "./maintenance"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerSessions } from "./session/register"
import { registerLatticeDomain } from "./lattice/register"
import { registerLatticeStartup } from "./lattice/startup"
import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { LatticeEvent } from "./lattice/event"
import { LatticeRuntime } from "./lattice/runtime"
import { BlueprintLoopSources } from "@ericsanchezok/synergy-blueprint/blueprint/source"
export function lattice(): RuntimeComponent {
  return {
    id: "lattice",
    features: componentFeatures,
    apiVersion: 1,
    version,
    requires: { "local-runtime": version, blueprint: version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    maintenance: new URL("./maintenance.ts", import.meta.url),
    services: () => ({ resident: { start: () => LatticeRuntime.init(), async stop() {} } }),
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      BlueprintLoopSources.register("lattice")
      registerMaintenance()
      registerSessions()
      registerLatticeDomain()
      registerLatticeStartup()
      BusEvent.register(...Object.values(LatticeEvent))
    },
  }
}
