import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerBridge } from "./register"
export function channelLattice(): RuntimeComponent {
  return {
    id: "channel-lattice",
    apiVersion: 1,
    version,
    requires: { channels: version, lattice: version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    register: registerBridge,
  }
}
