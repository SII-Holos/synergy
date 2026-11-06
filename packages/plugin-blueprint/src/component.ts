import { componentFeatures } from "./features"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerBridge } from "./register"
import { BlueprintLoopSources } from "@ericsanchezok/synergy-blueprint/blueprint/source"
export function pluginBlueprint(): RuntimeComponent {
  return {
    id: "plugin-blueprint",
    features: componentFeatures,
    apiVersion: 1,
    version,
    requires: { "plugin-host": version, blueprint: version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    register() {
      BlueprintLoopSources.register("plugin")
      registerBridge()
    },
  }
}
