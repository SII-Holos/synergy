import { componentFeatures } from "./features"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerCodingTools } from "./register-tools"

export function codeTools(): RuntimeComponent {
  return {
    id: "code-tools",
    features: componentFeatures,
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    register() {
      registerCodingTools()
    },
  }
}
