import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }

export function dataManagement(): RuntimeComponent {
  return {
    id: "data-management",
    apiVersion: 1,
    version,
    requires: { library: version, workflows: version, connections: version },
    adapters: { cli: new URL("./cli-adapter.ts", import.meta.url) },
    register() {},
  }
}
