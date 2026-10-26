import type { Migration } from "@ericsanchezok/synergy-harness/migration"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { InstallationGenerations } from "./generations"
import {
  initializeInstallationSelection,
  upgradeInstallationSelection,
  upgradeInstallationSelectionV2,
} from "./selection"
import { upgradeInstallationRoots } from "./upgrade"

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
  {
    id: "20261012-installation-selection-v2",
    description: "Expand legacy aggregate selections into independent capability owners",
    scope: "global",
    execution: "startup",
    dependsOn: ["20260926-installation-selection-v1"],
    async up(progress) {
      const current = await InstallationGenerations.current(Global.Path.root)
      await upgradeInstallationSelectionV2(
        Global.Path.root,
        Object.keys(current?.roots ?? {}),
        current ? Object.keys(upgradeInstallationRoots(current, current.hostVersion)) : undefined,
      )
      progress(1, 1)
    },
  },
  {
    id: "20261026-installation-selection-v3",
    description: "Remove retired identity components from saved installation selections",
    scope: "global",
    execution: "startup",
    dependsOn: ["20261012-installation-selection-v2"],
    async up(progress) {
      await upgradeInstallationSelection(Global.Path.root)
      progress(1, 1)
    },
  },
]

export function registerInstallationMigrations() {
  MigrationRegistry.register("installation", migrations)
}
