import { ConfigReferenceMigration } from "@ericsanchezok/synergy-harness/config/reference-migration"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export const migrations: Migration[] = [
  {
    id: "20261012-anima-config-owner",
    configuration: "files",
    description: "Move autonomous journal settings to Anima configuration",
    scope: "global",
    execution: "startup",
    dependsOn: ["library/20261012-library-config-owner"],
    upgradeConfig(config) {
      if (!record(config.library) || typeof config.library.autonomy !== "boolean") return
      if (config.anima === undefined) config.anima = {}
      if (!record(config.anima)) return
      if (config.anima.enabled === undefined) config.anima.enabled = config.library.autonomy
      delete config.library.autonomy
    },
    up: ConfigReferenceMigration.up,
  },
]
