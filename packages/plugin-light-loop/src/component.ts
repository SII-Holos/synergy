import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerBridge } from "./register"
export function pluginLightLoop(): RuntimeComponent {
  return {
    id: "plugin-light-loop",
    apiVersion: 1,
    version,
    requires: { "plugin-host": version, "light-loop": version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    register() {
      registerBridge()
    },
  }
}
