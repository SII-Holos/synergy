import { componentFeatures } from "./features"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerBridge } from "./register"
export function channelLightLoop(): RuntimeComponent {
  return {
    id: "channel-light-loop",
    features: componentFeatures,
    apiVersion: 1,
    version,
    requires: { channels: version, "light-loop": version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    register: registerBridge,
  }
}
