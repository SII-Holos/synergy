import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { componentFeatures } from "./features"

export function organizationRuntime(): RuntimeComponent {
  return {
    id: "organization-runtime",
    version,
    apiVersion: 1,
    features: componentFeatures,
    requires: { "local-runtime": version },
    adapters: { cli: new URL("./cli-adapter.ts", import.meta.url) },
    register() {},
  }
}
