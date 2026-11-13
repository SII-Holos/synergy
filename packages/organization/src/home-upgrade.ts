import path from "node:path"
import { z } from "zod"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { readOrganizationConfiguration } from "./configuration"
import { loadOrganizationInfrastructure } from "./infrastructure"
import { openOrganizationServiceHomeUpgrade } from "./service"
import { OrganizationServiceHome } from "./service-home"

export async function upgradeOrganizationServiceHome(input: { home: string; requestID: string; signal?: AbortSignal }) {
  if (!path.isAbsolute(input.home)) throw new Error("Organization upgrade requires an absolute existing Home")
  const requestID = z.string().min(1).max(128).parse(input.requestID)
  const signal = input.signal
  signal?.throwIfAborted()
  const configuration = await readOrganizationConfiguration(input.home)
  const infrastructure = await loadOrganizationInfrastructure(configuration.infrastructure)
  await using runtime = await openOrganizationServiceHomeUpgrade({ home: input.home, ...infrastructure })
  return await runtime.maintenance.run(async () => {
    const inspect = async (lease: RuntimeMaintenance.Lease) =>
      (await RuntimeMaintenance.status())?.phase === "released"
        ? RuntimeMaintenance.assertReleased(lease)
        : RuntimeMaintenance.assertHeld(lease)
    const perform = async (lease: RuntimeMaintenance.Lease) => {
      const retained = await inspect(lease)
      if (retained.phase === "draining")
        await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease, { signal }))
      if ((await inspect(lease)).phase === "frozen") await runtime.upgrade({ lease, signal })
      await OrganizationServiceHome.assertUpgradeComplete()
      const released = await RuntimeMaintenance.release(lease, { signal })
      if (released.version !== 2) throw new Error("Home upgrade requires its original native publication witness")
      const host = RuntimeContext.current().host
      const files = HomeOwnershipFile.open({ root: host.root, env: host.env, selected: released.native.target })
      if ((await files.physicalHash()) !== released.native.physicalHash)
        throw new Error("Home upgrade no longer owns its original physical Home")
      await files.advanceReader(released.native.target, { signal })
      if ((await files.physicalHash()) !== released.native.physicalHash)
        throw new Error("Home upgrade no longer owns its original physical Home")
      await RuntimeMaintenance.assertReleased(lease)
      await OrganizationServiceHome.assertUpgradeComplete()
      const marker = released.native.target
      return {
        state: "upgrade-complete" as const,
        restartRequired: true,
        executesAgents: false,
        schemaVersion: marker.schemaVersion,
        readerContract: marker.readerContract,
        requestID,
        maintenanceID: released.maintenanceID,
      }
    }
    const current = await RuntimeMaintenance.status()
    if (current?.requestID === requestID)
      return RuntimeMaintenance.withHomeUpgradeRecovery({ requestID, signal }, perform)
    const lease = await RuntimeMaintenance.begin({
      purpose: "organization-home-upgrade",
      requestID,
      signal,
      actor: {
        kind: "system",
        subjectID: "organization-home-upgrade",
        displayName: "Organization Home upgrade",
        clientKind: "system",
        requestID,
      },
    })
    return perform(lease)
  })
}
