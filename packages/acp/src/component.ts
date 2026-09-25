import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }

export function acp(): RuntimeComponent {
  return {
    id: "acp",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    register() {},
  }
}
