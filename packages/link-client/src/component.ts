import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerSynergyLinkTools } from "./tools"
import { registerToolLinkTargetSource } from "./tool-target-source"

export function linkClient(): RuntimeComponent {
  return {
    id: "link-client",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      registerSynergyLinkTools()
      registerToolLinkTargetSource()
    },
  }
}
