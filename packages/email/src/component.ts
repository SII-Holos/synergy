import { componentFeatures } from "./features"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerConfig } from "./config-schema"
import { registerEmailTools } from "./email/tools"
import { Email } from "./email/service"
export function email(): RuntimeComponent {
  return {
    id: "email",
    features: componentFeatures,
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    adapters: { http: new URL("./http.ts", import.meta.url) },
    services: () => ({ disposeExtensions: async () => Email.close() }),
    register() {
      registerConfig()
      registerEmailTools()
    },
  }
}
