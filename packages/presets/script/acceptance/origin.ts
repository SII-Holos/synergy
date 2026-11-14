import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../../package.json" with { type: "json" }

export function acceptanceOrigins() {
  let owner: ReturnType<typeof EnvironmentOrigin.registerHost> | undefined
  const component: RuntimeComponent = {
    id: "acceptance-origins",
    version,
    apiVersion: 1,
    register() {
      owner = EnvironmentOrigin.registerHost("acceptance-controller")
    },
  }
  return {
    component,
    capture(invocationID: string) {
      if (!owner) throw new Error("Acceptance origins require their composed native Host")
      return owner.capture(invocationID)
    },
  }
}
