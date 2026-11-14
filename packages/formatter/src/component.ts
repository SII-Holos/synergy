import { componentFeatures } from "./features"
import { registerReload } from "./reload"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerFormatterStartup } from "./startup"
import { registerConfig } from "./config-schema"
import { FormatterProcess } from "./process"

export function formatter(): RuntimeComponent {
  return {
    id: "formatter",
    features: componentFeatures,
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      FormatterProcess.register()
      registerReload()
      registerConfig()
      registerFormatterStartup()
    },
  }
}
