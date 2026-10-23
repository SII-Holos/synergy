import { componentFeatures } from "./features"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerBridge } from "./register"
export function agendaBlueprint(): RuntimeComponent {
  return {
    id: "agenda-blueprint",
    features: componentFeatures,
    apiVersion: 1,
    version,
    requires: { agenda: version, blueprint: version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    register() {
      registerBridge()
    },
  }
}
