import { PrimaryAgentUpgrade } from "@ericsanchezok/synergy-harness/agent/primary-identity-upgrade"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
export function upgradeOwnerSession(key: string[], value: Record<string, unknown>) {
  if (key[0] !== "sessions") return
  if (key.length === 4 && key[3] === "info") {
    const legacy = record(value.lattice)
    if (
      legacy &&
      typeof legacy.runID === "string" &&
      (legacy.mode === "auto" || legacy.mode === "collaborative") &&
      !value.workflow
    ) {
      value.workflow = { kind: "lattice", runID: legacy.runID, mode: legacy.mode }
      delete value.lattice
    }
  }
  if (key.length === 6 && key[3] === "messages" && key[5] === "info") {
    const metadata = record(value.metadata)
    if (!metadata) return
    const kind =
      metadata.workflowMode === "light_loop"
        ? "lightloop"
        : (metadata.workflowMode ?? (metadata.planModeRequest === true ? "plan" : undefined))
    if (kind !== "lattice") return
    metadata.workflow = kind
    metadata.workflowVersion = 1
    const agent = metadata.workflowModeAgent ?? metadata.planModeAgent
    if (typeof agent === "string") metadata.workflowAgent = agent
    for (const field of [
      "planModeRequest",
      "planModeAgent",
      "planModeWrapperVersion",
      "workflowMode",
      "workflowModeAgent",
      "workflowModeVersion",
    ])
      delete metadata[field]
  }
}
export const migrations: Migration[] = [
  {
    id: "20261012-lattice-session-owner",
    description: "Upgrade retained lattice Session state when its owner is selected",
    scope: "global",
    execution: "startup",
    upgradeRecord: upgradeOwnerSession,
    async up(progress) {
      let count = 0
      for (const key of await Storage.list(["sessions"])) {
        if (
          !(key.length === 4 && key[3] === "info") &&
          !(key.length === 6 && key[3] === "messages" && key[5] === "info")
        )
          continue
        const value = await Storage.read<Record<string, unknown>>(key)
        const before = JSON.stringify(value)
        upgradeOwnerSession(key, value)
        if (before !== JSON.stringify(value)) await Storage.write(key, value)
        progress(++count, 0)
      }
      progress(count, count)
    },
  },
]
export function registerSessionMigrations() {
  MigrationRegistry.register("lattice-session", migrations)
}
