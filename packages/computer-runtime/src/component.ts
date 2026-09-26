import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerComputerTools } from "./tools"

export function computer(): RuntimeComponent {
  return {
    id: "computer-runtime",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      registerComputerTools()
    },
  }
}
