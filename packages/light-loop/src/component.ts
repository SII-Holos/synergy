import { registerSessionMigrations } from "./session-migration"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerSessionSchema } from "./session-schema"
import { registerSessions } from "./session/register"
import { registerLightLoopDomain } from "./light-loop/register"
export function lightLoop(): RuntimeComponent {
  return {
    id: "light-loop",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      registerSessionMigrations()
      registerSessionSchema()
      registerSessions()
      registerLightLoopDomain()
    },
  }
}
