import { componentFeatures } from "./features"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerBridge } from "./register"
export function pluginAgenda(): RuntimeComponent {
  return {
    id: "plugin-agenda",
    features: componentFeatures,
    apiVersion: 1,
    version,
    requires: { "plugin-host": version, agenda: version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    register() {
      registerBridge()
    },
  }
}
