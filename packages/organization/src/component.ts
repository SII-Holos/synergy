import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { componentFeatures } from "./features"
import { registerOrganizationMigrations } from "./migration"

export function organization(): RuntimeComponent {
  return {
    id: "organization",
    version,
    apiVersion: 1,
    features: componentFeatures,
    register: registerOrganizationMigrations,
  }
}
