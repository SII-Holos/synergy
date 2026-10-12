import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerBridge } from "./register"
export function channelBlueprint(): RuntimeComponent {
  return {
    id: "channel-blueprint",
    apiVersion: 1,
    version,
    requires: { channels: version, blueprint: version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    register: registerBridge,
  }
}
