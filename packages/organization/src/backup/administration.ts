import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { z } from "zod"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { StorageCheckpoint } from "@ericsanchezok/synergy-harness/storage/checkpoint"
import { SnapshotMaintenance } from "@ericsanchezok/synergy-harness/session/snapshot-maintenance"
import { OrganizationBackupCohort as Cohort } from "./cohort"
import { OrganizationRecoveryArchive as Archive } from "./archive"
import { OrganizationServiceNative as Native } from "./service-native"
import { OrganizationRecoveryAuthority as Authority } from "./authority"
import { OrganizationServiceHome } from "../service-home"
import { readOrganizationConfiguration } from "../configuration"
import { loadOrganizationInfrastructure } from "../infrastructure"
import { openOrganizationRecovery, openOrganizationService } from "../service"

import type { VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"

async function directoryEntries(directory: string, expected: string[]) {
  const pending = new Set(expected)
  for await (const entry of await fs.opendir(directory))
    if (!pending.delete(entry.name)) throw new Error("Restore contains an unrecognized namespace or facet")
  if (pending.size) throw new Error("Restore is missing a required namespace or facet")
}

export namespace OrganizationBackupAdministration {
  export async function capture(input: {
    home: string
    directory: string
    buildVersion: string
    keys: VaultKeyProvider
    publicOrigin?: string
    signal?: AbortSignal
  }) {
    const { home, directory, buildVersion, keys, publicOrigin, signal } = input
    signal?.throwIfAborted()
    if (!path.isAbsolute(home) || !path.isAbsolute(directory)) throw new Error("Backup requires absolute native paths")
    const owner = await HomeOwnershipFile.open({ root: path.join(home, ".synergy"), env: process.env }).read()
    if (
      !owner ||
      owner.owner !== "organization" ||
      (owner.schemaVersion !== 2 && owner.schemaVersion !== 3) ||
      owner.readerContract !== OrganizationServiceHome.readerContract
    )
      throw new Error("Backup requires an existing ordinary organization Home")
    const existing = await fs.lstat(directory).then(
      () => true,
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
        throw error
      },
    )
    if (existing) throw new Error("Backup output must be a new directory")
    const configuration = await readOrganizationConfiguration(home)
    signal?.throwIfAborted()
    await using service = await openOrganizationService({
      ...configuration,
      ...(await loadOrganizationInfrastructure(configuration.infrastructure)),
      home,
      publicOrigin,
    })
    const requestID = crypto.randomUUID()
    return await Cohort.capture({
      service: Cohort.service(service.maintenance),
      async resolve() {
        return undefined
      },
      directory,
      archiveID: requestID,
      buildVersion,
      keys,
      signal,
      actor: {
        kind: "system",
        subjectID: "host-operator",
        displayName: "Host operator",
        clientKind: "system",
        requestID,
      },
    })
  }
  export async function install(input: {
    home: string
    directory: string
    restoreID: string
    keys: VaultKeyProvider
    signal?: AbortSignal
  }) {
    const { home, directory, restoreID, keys, signal } = input
    signal?.throwIfAborted()
    if (!path.isAbsolute(home) || !path.isAbsolute(directory)) throw new Error("Restore requires absolute native paths")
    z.uuid().parse(restoreID)

    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "synergy-organization-restore-"))
    try {
      const opened = path.join(temporary, "opened")
      const report = await Archive.open({ directory, outputDirectory: opened, keys, signal })
      await directoryEntries(opened, ["cohort.json", "namespaces"])
      const cohort = Cohort.Inventory.parse(await Bun.file(path.join(opened, "cohort.json")).json())
      if (cohort.namespaces !== 1)
        throw new Error("Restore requires every archived namespace's original installation owner")
      await directoryEntries(path.join(opened, "namespaces"), ["0000000000000000"])
      const base = path.join(opened, "namespaces", "0000000000000000")
      await directoryEntries(base, ["namespace.json", "native", "records", "snapshots"])
      const inventory = Cohort.NamespaceInventory.parse(await Bun.file(path.join(base, "namespace.json")).json())
      if (
        inventory.ordinal !== 0 ||
        inventory.identity.kind !== "service" ||
        !inventory.native ||
        inventory.identity.orgID !== cohort.orgID ||
        inventory.identity.deploymentIncarnation !== cohort.deploymentIncarnation
      )
        throw new Error("Restore requires the original service namespace and native facets")
      const expectedNative = inventory.native
      const request = Native.installationRequest({
        restoreID: restoreID,
        source: inventory.namespace,
        expected: inventory.native,
        snapshot: inventory.segment.namespace,
        cohort: {
          archiveID: report.archiveID,
          pagesHash: report.pagesHash,
          ordinal: 0,
          source: { orgID: cohort.orgID, deploymentIncarnation: cohort.deploymentIncarnation },
        },
      })
      await fs.mkdir(home, { recursive: true, mode: 0o700 })
      await using runtime = await openOrganizationRecovery({ home: await fs.realpath(home) })
      const receipt = await runtime.run(async () => {
        const selected = await HomeRestoration.begin(request, { signal })
        return HomeRestoration.withTarget(
          selected,
          (permit) =>
            Native.withInstalled(
              {
                directory: path.join(base, "native"),
                expected: expectedNative,
                source: inventory.namespace,
                keys,
                permit,
                request,
                signal,
              },
              (native) =>
                SnapshotMaintenance.withInstalledSegment(
                  {
                    directory: path.join(base, "snapshots"),
                    namespaceDirectory: path.join(base, "records"),
                    source: inventory.namespace,
                    expected: inventory.segment.namespace,
                    keys,
                    permit,
                    request,
                    signal,
                  },
                  async (snapshot) => {
                    await StorageCheckpoint.restoreArchive({
                      directory: path.join(base, "records"),
                      expected: inventory.namespace,
                      keys,
                      signal,
                      restoreID: request.restoreID,
                      finalize: (tx, archive) =>
                        Native.adoptRestoration(tx, { permit, request, native, snapshot, archive }).then(() => {}),
                    })
                    const prepared = await Authority.prepare({
                      permit,
                      request,
                      signal,
                      native,
                      namespaceDirectory: path.join(base, "records"),
                      keys,
                    })
                    const info = HomeRestoration.describe(permit)
                    return {
                      state: "recovery-held",
                      executionEnabled: false,
                      restoreID: request.restoreID,
                      installationID: info.installationID,
                      incarnation: info.incarnation,
                      sourceHash: info.sourceHash,
                      prepared: Authority.describe(prepared).identity,
                    }
                  },
                ),
            ),
          { signal },
        )
      })
      return receipt
    } finally {
      await fs.rm(temporary, { recursive: true, force: true })
    }
  }
}
