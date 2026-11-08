import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { componentFeatures } from "./features"

export function organization(): RuntimeComponent {
  return {
    id: "organization",
    version,
    apiVersion: 1,
    features: componentFeatures,
    adapters: { cli: new URL("./cli-adapter.js", import.meta.url) },
    register() {},
  }
}
