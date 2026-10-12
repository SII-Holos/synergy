import { registerSessionMigrations } from "./session-migration"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerSessionSchema } from "./session-schema"
import { registerLatticeMigrations } from "./lattice/migration"
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
    apiVersion: 1,
    version,
    requires: { "local-runtime": version, blueprint: version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    services: () => ({ resident: { start: () => LatticeRuntime.init(), async stop() {} } }),
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      BlueprintLoopSources.register("lattice")
      registerSessionMigrations()
      registerSessionSchema()
      registerLatticeMigrations()
      registerSessions()
      registerLatticeDomain()
      registerLatticeStartup()
      BusEvent.register(...Object.values(LatticeEvent))
    },
  }
}
