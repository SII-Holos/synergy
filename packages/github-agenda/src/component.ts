import { componentFeatures } from "./features"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerBridge } from "./register"
export function githubAgenda(): RuntimeComponent {
  return {
    id: "github-agenda",
    features: componentFeatures,
    apiVersion: 1,
    version,
    requires: { github: version, agenda: version },
    adapters: { http: new URL("./http.ts", import.meta.url) },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    register() {
      registerBridge()
    },
  }
}
