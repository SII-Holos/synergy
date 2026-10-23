import { componentFeatures } from "./features"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }

export function dataManagement(): RuntimeComponent {
  return {
    id: "data-management",
    features: componentFeatures,
    apiVersion: 1,
    version,
    requires: {
      library: version,
      note: version,
      agenda: version,
      blueprint: version,
      channels: version,
      holos: version,
    },
    adapters: { cli: new URL("./cli-adapter.ts", import.meta.url) },
    register() {},
  }
}
