import fs from "node:fs/promises"
import path from "node:path"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { NativeNamespaceIdentity } from "@ericsanchezok/synergy-harness/lifecycle/namespace-identity"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { getMigrationStatus, runMigrations, type Migration } from "@ericsanchezok/synergy-harness/migration"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { loadSigningAuthority } from "./signing"
import { digest } from "./auth/secret"

const domain = "organization-service-home"
const selected = Object.freeze({
  schemaVersion: 2 as const,
  owner: "organization",
  identity: digest("synergy.organization.service.v1"),
  readerContract: "native-organization-service-ownership-v1",
})
const request = RuntimeContext.createAsyncContext<{
  home: string
  lease: RuntimeMaintenance.Lease
  writer: ServerProcessLock.Ownership
  signal?: AbortSignal
}>()
function fail(message: string): never {
  throw new HomeOwnershipFile.Error(message)
}
function owner() {
  const { host } = RuntimeContext.current()
  if (path.resolve(host.root) !== path.join(path.resolve(host.home), ".synergy"))
    fail("Service Home requires its canonical native root")
  return { host, files: HomeOwnershipFile.open({ root: host.root, env: host.env, selected }) }
}
async function retainedOwner() {
  const current = owner()
  for (const directory of [current.host.home, current.host.root]) {
    const info = await fs.lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) fail("Service Home requires its independent native directory")
  }
  const ownership = await current.files.read()
  if (!ownership || ownership.owner !== selected.owner || ownership.identity !== selected.identity)
    fail("Service Home cannot adopt a missing or foreign owner")
  if (ownership.schemaVersion === 2 && ownership.readerContract !== selected.readerContract)
    fail("Service Home reader contract is unsupported")
  return { ...current, ownership }
}
async function records() {
  const current = await retainedOwner()
  const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
  await loadSigningAuthority(deployment)
  return { ...current, deployment }
}
async function assertRequest() {
  const current = request.getStore()
  if (!current) fail("Service Home upgrade requires explicit frozen native maintenance")
  if (path.resolve(current.home) !== path.resolve(RuntimeContext.current().host.home))
    fail("Service Home upgrade belongs to another native Home")
  current.signal?.throwIfAborted()
  const maintenance = await RuntimeMaintenance.assertHeld(current.lease)
  if (maintenance.phase !== "frozen") fail("Service Home upgrade requires its current frozen native cohort")
  await ServerProcessLock.verifyOwnership(current.writer)
  current.signal?.throwIfAborted()
  return current
}
const migration: Migration = {
  id: "20261112-organization-service-home-reader-fence-v2",
  description: "Fence organization service readers before publishing native maintenance authority",
  scope: "global",
  execution: "maintenance",
  dependsOn: ["organization/20261111-organization-authority-history"],
  async isApplied() {
    return (await records()).ownership.schemaVersion === 2
  },
  async up(progress) {
    const current = await assertRequest()
    const native = owner()
    await withFileLock(
      {
        directory: path.join(native.host.root, "state", ".locks"),
        key: "organization-service-home-format",
        signal: current.signal,
      },
      async () => {
        await assertRequest()
        const retained = await records()
        await retained.files.upgrade(
          { schemaVersion: 1, owner: selected.owner, identity: selected.identity },
          { signal: current.signal },
        )
        await assertRequest()
        progress(1, 1)
      },
    )
  },
}
const migrations = [migration]
const initializationMigration: Migration = {
  id: "20261108-organization-home-ownership",
  description: "Retain independent organization Home ownership when execution components are absent",
  scope: "global",
  execution: "startup",
  dependsOn: ["20261108-organization-deployment"],
  async up(progress) {
    await HomeOwnership.persist()
    progress(1, 1)
  },
}

export namespace OrganizationServiceHome {
  export const readerContract = selected.readerContract
  export const recoveryReaderContract = "native-organization-service-recovery-v1"
  export function archivedOwner(value: unknown) {
    const current = HomeOwnershipFile.FencedInfo.parse(value)
    if (
      current.owner !== selected.owner ||
      current.identity !== selected.identity ||
      current.readerContract !== selected.readerContract
    )
      fail("Archived service Home belongs to another native owner or reader")
    return current
  }
  export function installOwner(permit: HomeRestoration.InstallPermit) {
    if (HomeRestoration.describe(permit).owner !== selected.owner)
      fail("Service installation belongs to another native domain")
    return HomeRestoration.installOwner(permit, {
      identity: selected.identity,
      readerContract: recoveryReaderContract,
    })
  }
  export const initialization = initializationMigration
  export async function assertStartupOwner() {
    owner()
    const retained = await HomeOwnership.assert()
    if (retained) {
      if (retained.owner !== selected.owner || retained.identity !== selected.identity)
        fail("Service startup belongs to another Home owner")
      return
    }
    const status = (await getMigrationStatus("organization")).organization
    if (!status || ![...status.completed, ...status.pending].some((item) => item.id === initializationMigration.id))
      fail("Service startup requires its canonical initialization owner")
    if (status.completed.some((item) => item.id === initializationMigration.id))
      fail("Missing established service Home ownership requires native recovery")
    if ((await Storage.queryKeys({ prefix: Keys.signingIdentity(), limit: 1 })).length)
      fail("Unknown service initialization history requires native recovery")
  }
  export function select() {
    HomeOwnership.select({
      owner: selected.owner,
      identity: selected.identity,
      readerContract: selected.readerContract,
    })
  }
  export async function retirementOwner() {
    const current = await retainedOwner()
    const source = current.ownership.schemaVersion === 4 ? current.ownership.source : current.ownership
    if (
      (source.schemaVersion !== 2 && source.schemaVersion !== 3) ||
      source.readerContract !== (source.schemaVersion === 2 ? readerContract : recoveryReaderContract)
    )
      fail("Service retirement requires its original supported Home owner")
    return current
  }
  export async function inspectRetirement(input: HomeOwnershipFile.RetirementInfo) {
    const marker = HomeOwnershipFile.RetirementInfo.parse(structuredClone(input))
    const source = marker.source
    if (
      source.owner !== selected.owner ||
      source.identity !== selected.identity ||
      source.readerContract !== (source.schemaVersion === 2 ? readerContract : recoveryReaderContract)
    )
      fail("Service retirement requires its original supported Home owner")
    const { host } = owner()
    for (const directory of [host.home, host.root]) {
      const info = await fs.lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) fail("Service retirement requires its independent native Home")
    }
    const files = HomeOwnershipFile.open({ root: host.root, env: host.env, selected: marker })
    const status = await files.inspectRetirement(source)
    return { files, status, marker }
  }
  export async function selectForRetirement(marker: HomeOwnershipFile.RetirementInfo) {
    const native = await inspectRetirement(marker)
    HomeOwnership.select(native.status === "source" ? native.marker.source : native.marker)
  }
  export async function selectForRecovery() {
    const current = await owner().files.read()
    if (current?.schemaVersion !== 3) return select()
    if (
      current.owner !== selected.owner ||
      current.identity !== selected.identity ||
      current.readerContract !== recoveryReaderContract
    )
      fail("Service recovery Home belongs to another native owner or reader")
    await HomeRestoration.assertPendingOwner(current)
    HomeOwnership.select(current)
  }
  export async function selectForUpgrade() {
    const { ownership } = await retainedOwner()
    HomeOwnership.select({
      owner: selected.owner,
      identity: selected.identity,
      ...(ownership.schemaVersion === 2 ? { readerContract: selected.readerContract } : {}),
    })
    await HomeOwnership.assert({ required: true })
  }
  export function registerMigration() {
    MigrationRegistry.register(domain, migrations)
  }
  export function registerNamespaceIdentity() {
    NativeNamespaceIdentity.register({
      owner: selected.owner,
      async read() {
        const { deployment } = await records()
        return { kind: "service", orgID: deployment.orgID, deploymentIncarnation: deployment.deploymentIncarnation }
      },
    })
  }
  export async function upgrade(input: { home: string; lease: RuntimeMaintenance.Lease; signal?: AbortSignal }) {
    const home = input.home
    const lease = input.lease
    const signal = input.signal
    if (!path.isAbsolute(home)) fail("Service Home must be absolute")
    signal?.throwIfAborted()
    const writer = await ServerProcessLock.currentOwnership()
    return RuntimeMaintenance.withFrozen(
      lease,
      () =>
        request.run({ home, lease, signal, writer }, async () => {
          await assertRequest()
          const result = await runMigrations({ targetDomain: domain, maintenance: true, output: "silent", signal })
          await assertRequest()
          if ((await records()).ownership.schemaVersion !== 2)
            fail("Service Home migration receipt does not match its canonical ownership")
          return result
        }),
      { signal },
    )
  }
}
