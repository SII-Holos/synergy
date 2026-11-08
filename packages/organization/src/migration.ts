import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationStoragePath } from "./storage/path"

const migrations: Migration[] = [
  {
    id: "20261108-organization-deployment",
    description: "Establish independent organization deployment identity",
    scope: "global",
    execution: "startup",
    async up(progress) {
      const deployment = OrganizationProtocol.Deployment.parse({
        schemaVersion: 1,
        orgID: crypto.randomUUID(),
        deploymentIncarnation: crypto.randomUUID(),
        createdAt: Date.now(),
      })
      await Storage.transaction(async () => {
        const existing = await Storage.read<unknown>(OrganizationStoragePath.deployment(), {
          silentNotFound: true,
        }).catch((error: unknown) => {
          if (error instanceof Storage.NotFoundError) return undefined
          throw error
        })
        if (existing !== undefined) {
          OrganizationProtocol.Deployment.parse(existing)
          return
        }
        await Storage.write(OrganizationStoragePath.deployment(), deployment)
      })
      progress(1, 1)
    },
  },
]

export function registerOrganizationMigrations() {
  MigrationRegistry.register("organization", migrations)
}
