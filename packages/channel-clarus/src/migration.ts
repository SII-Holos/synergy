import { HolosAccounts } from "@ericsanchezok/synergy-holos/holos/accounts"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"
import { isRetryableIOError } from "@ericsanchezok/synergy-util/io-retry"
const log = Log.create({ service: "channel-clarus.migration" })
export const migrations: Migration[] = [
  {
    id: "20260728-provision-clarus-channel-account",
    description: "Provision a disabled Clarus Channel account for the active Holos identity.",
    domain: "holos",
    dependsOn: ["20260620-migrate-holos-legacy-credentials"],
    async up(progress) {
      progress(0, 1)
      const account = await HolosAccounts.getActiveAccount().catch((error) => {
        if (error instanceof HolosAccounts.MalformedStoreError) {
          log.warn("skipping clarus channel account provisioning because the Holos account store is malformed")
          return undefined
        }
        if (isRetryableIOError(error)) {
          log.warn(
            "skipping clarus channel account provisioning because the Holos account store is temporarily unavailable",
            {
              error: String(error),
            },
          )
          return undefined
        }
        throw error
      })
      if (account) {
        const { ensureClarusChannelAccount } = await import("./account-configured")
        const provisioned = await ensureClarusChannelAccount(account.agentId)
        if (provisioned) log.info("provisioned clarus channel account for active holos identity")
      }
      progress(1, 1)
    },
  },
]
export function registerMigrations() {
  MigrationRegistry.register("channel-clarus", migrations)
}
