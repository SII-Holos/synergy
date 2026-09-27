import type { Migration } from "@ericsanchezok/synergy-harness/migration"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { InstallationGenerations } from "./generations"
import { initializeInstallationSelection } from "./selection"

const migrations: Migration[] = [
  {
    id: "20260926-installation-selection-v1",
    description: "Preserve the existing product selection when adopting installable modules",
    scope: "global",
    execution: "startup",
    async up(progress) {
      const current = await InstallationGenerations.current(Global.Path.root)
      await initializeInstallationSelection(Global.Path.root, Object.keys(current?.roots ?? {}))
      progress(1, 1)
    },
  },
]

export function registerInstallationMigrations() {
  MigrationRegistry.register("installation", migrations)
}
