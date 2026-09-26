import { registerReload } from "./reload"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerFormatterStartup } from "./startup"
import { registerConfig } from "./config-schema"

export function formatter(): RuntimeComponent {
  return {
    id: "formatter",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      registerReload()
      registerConfig()
      registerFormatterStartup()
    },
  }
}
