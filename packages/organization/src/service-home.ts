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
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentExecution } from "@ericsanchezok/synergy-harness/environment/execution"

const domain = "organization-service-home"
const selected = Object.freeze({
  schemaVersion: 2 as const,
  owner: "organization",
  identity: digest("synergy.organization.service.v1"),
  readerContract: "native-organization-service-ownership-v1",
})
const environmentReader = "native-organization-service-environments-v1"
const recoveryReader = "native-organization-service-recovery-v1"
const environmentRecoveryReader = "native-organization-service-environments-recovery-v1"
type Reader = typeof selected.readerContract | typeof environmentReader
const readers = RuntimeContext.state<{ current: Reader; target?: Reader }>(() => ({ current: selected.readerContract }))
const request = RuntimeContext.createAsyncContext<{
  home: string
  lease: RuntimeMaintenance.Lease
  writer: ServerProcessLock.Ownership
  signal?: AbortSignal
  assert(): void
}>()
function fail(message: string): never {
  throw new HomeOwnershipFile.Error(message)
}
function ordinaryReader(value: string): Reader {
  if (value === selected.readerContract || value === environmentReader) return value
  fail("Service Home reader contract is unsupported")
}
function assertReaderOwner(current: Extract<HomeOwnershipFile.Info, { schemaVersion: 2 | 3 }>) {
  if (current.owner !== selected.owner || current.identity !== selected.identity)
    fail("Service Home belongs to another native owner")
  if (current.schemaVersion === 2) {
    ordinaryReader(current.readerContract)
    return
  }
  if (current.readerContract !== recoveryReader && current.readerContract !== environmentRecoveryReader)
    fail("Service Home recovery reader contract is unsupported")
}
function owner(target = false) {
  const { host } = RuntimeContext.current()
  if (path.resolve(host.root) !== path.join(path.resolve(host.home), ".synergy"))
    fail("Service Home requires its canonical native root")
  return {
    host,
    files: HomeOwnershipFile.open({
      root: host.root,
      env: host.env,
      selected: { ...selected, readerContract: target ? (readers().target ?? readers().current) : readers().current },
    }),
  }
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
  if (ownership.schemaVersion === 2 || ownership.schemaVersion === 3) assertReaderOwner(ownership)
  if (ownership.schemaVersion === 4) assertReaderOwner(ownership.source)
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
  current.assert()
  if (path.resolve(current.home) !== path.resolve(RuntimeContext.current().host.home))
    fail("Service Home upgrade belongs to another native Home")
  current.signal?.throwIfAborted()
  const maintenance = await RuntimeMaintenance.assertHeld(current.lease)
  if (maintenance.phase !== "frozen") fail("Service Home upgrade requires its current frozen native cohort")
  await ServerProcessLock.verifyOwnership(current.writer)
  current.assert()
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
    const native = owner(true)
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
const environmentMigration: Migration = {
  id: "20261113-organization-service-environment-reader",
  description: "Fence released Service readers before accepting native Environment effects",
  scope: "global",
  execution: "maintenance",
  dependsOn: [migration.id],
  async isApplied() {
    const { ownership } = await records()
    return ownership.schemaVersion === 2 && ownership.readerContract === environmentReader
  },
  async up(progress) {
    const current = await assertRequest()
    if (readers().target !== environmentReader)
      fail("Environment reader upgrade requires its explicit infrastructure target")
    await OrganizationServiceHome.assertEnvironmentUpgradeIdle()
    const original = (await records()).ownership
    if (original.schemaVersion !== 2 || ordinaryReader(original.readerContract) !== selected.readerContract)
      fail("Environment reader upgrade requires its original ordinary Service Home")
    const native = owner(true)
    await withFileLock(
      {
        directory: path.join(native.host.root, "state", ".locks"),
        key: "organization-service-home-format",
        signal: current.signal,
      },
      async () => {
        await assertRequest()
        if (JSON.stringify((await records()).ownership) !== JSON.stringify(original))
          fail("Service Home owner changed before reader advancement")
        await native.files.advanceReader(original, { signal: current.signal })
        await assertRequest()
        const after = (await records()).ownership
        if (after.schemaVersion !== 2 || after.readerContract !== environmentReader)
          fail("Environment reader advancement did not retain its original target")
        progress(1, 1)
      },
    )
  },
}
const environmentMigrations = [...migrations, environmentMigration]
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
  export const environmentReaderContract = environmentReader
  export const recoveryReaderContract = recoveryReader
  export const environmentRecoveryReaderContract = environmentRecoveryReader
  export function archivedOwner(value: unknown) {
    const current = HomeOwnershipFile.FencedInfo.parse(value)
    assertReaderOwner(current)
    return current
  }
  export function installOwner(permit: HomeRestoration.InstallPermit, archivedSourceOwner: unknown) {
    if (HomeRestoration.describe(permit).owner !== selected.owner)
      fail("Service installation belongs to another native domain")
    const source = archivedOwner(archivedSourceOwner)
    return HomeRestoration.installOwner(permit, {
      identity: selected.identity,
      readerContract: source.readerContract === environmentReader ? environmentRecoveryReader : recoveryReader,
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
      readerContract: readers().current,
    })
  }
  export async function retirementOwner() {
    const current = await retainedOwner()
    const source = current.ownership.schemaVersion === 4 ? current.ownership.source : current.ownership
    if (source.schemaVersion !== 2 && source.schemaVersion !== 3)
      fail("Service retirement requires its original supported Home owner")
    assertReaderOwner(source)
    return current
  }
  export async function inspectRetirement(input: HomeOwnershipFile.RetirementInfo) {
    const marker = HomeOwnershipFile.RetirementInfo.parse(structuredClone(input))
    const source = marker.source
    assertReaderOwner(source)
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
  export async function selectForStartup(options: { environments?: boolean } = {}) {
    RuntimeContext.assertCompositionOpen("Service Home reader selection")
    const current = await owner().files.read()
    if (current?.schemaVersion !== 3) {
      if (current?.schemaVersion === 2) assertReaderOwner(current)
      readers().current =
        (current?.schemaVersion === 2 && ordinaryReader(current.readerContract) === environmentReader) ||
        options.environments
          ? environmentReader
          : selected.readerContract
      select()
      return false
    }
    assertReaderOwner(current)
    if (options.environments && current.readerContract !== environmentRecoveryReader)
      fail("Environment activation for a restored Home requires its verified reader upgrade owner")
    await HomeRestoration.inspectCompleted()
    HomeOwnership.select(current)
    return true
  }
  export async function selectForRecovery() {
    const current = await owner().files.read()
    if (current?.schemaVersion !== 3) {
      if (current?.schemaVersion === 2) {
        assertReaderOwner(current)
        readers().current = ordinaryReader(current.readerContract)
      }
      return select()
    }
    assertReaderOwner(current)
    await HomeRestoration.assertPendingOwner(current)
    HomeOwnership.select(current)
  }
  export async function selectForUpgrade(options: { environments?: boolean } = {}) {
    RuntimeContext.assertCompositionOpen("Service Home reader upgrade selection")
    const { ownership } = await retainedOwner()
    if (ownership.schemaVersion === 3 && options.environments)
      fail("Environment activation for a restored Home requires its verified reader upgrade owner")
    if (ownership.schemaVersion === 2) readers().current = ordinaryReader(ownership.readerContract)
    readers().target =
      readers().current === environmentReader || options.environments ? environmentReader : selected.readerContract
    HomeOwnership.select({
      owner: selected.owner,
      identity: selected.identity,
      ...(ownership.schemaVersion === 2 ? { readerContract: readers().current } : {}),
    })
    await HomeOwnership.assert({ required: true })
  }
  export function registerMigration() {
    MigrationRegistry.register(
      domain,
      readers().target === environmentReader || readers().current === environmentReader
        ? environmentMigrations
        : migrations,
    )
  }
  export async function assertEnvironmentReader() {
    const ownership = await HomeOwnership.assert({ required: true })
    if (ownership?.schemaVersion === 2 && ownership.readerContract === environmentReader) return
    if (ownership?.schemaVersion !== 3 || ownership.readerContract !== environmentRecoveryReader)
      fail("Native Environment effects require their explicit Service Home reader owner")
    assertReaderOwner(ownership)
    await HomeRestoration.inspectCompleted()
    await HomeRestoration.assertOrdinaryStartup()
    if (JSON.stringify(await HomeOwnership.assert({ required: true })) !== JSON.stringify(ownership))
      fail("Native Environment recovery reader changed after completed publication inspection")
  }
  export async function assertEnvironmentUpgradeIdle() {
    if (readers().target !== environmentReader || readers().current === environmentReader) return
    await assertUpgradeIdle()
  }
  async function assertUpgradeIdle() {
    for await (const environment of Environment.entries())
      if (environment.state !== "idle")
        fail("Unfenced native Environment allocation requires its original recovery owner")
    for await (const _use of Environment.useEntries())
      fail("Unfenced native Environment Uses require their original recovery owner")
    for await (const execution of EnvironmentExecution.entries())
      if (execution.state !== "completed") fail("Unfenced native executions require their original recovery owner")
  }
  export function registerUpgradeOwner() {
    RuntimeMaintenance.registerHomeUpgradeOwner("organization-service", {
      version: 1,
      async capture(signal) {
        const assert = WorkspaceContent.captureOwner(signal)
        const { ownership, deployment } = await records()
        const source = HomeOwnershipFile.FencedInfo.parse(ownership)
        const target = HomeOwnershipFile.FencedInfo.parse({
          ...source,
          readerContract: readers().target ?? readers().current,
        })
        const proof = await NativeNamespaceIdentity.capture()
        const signing = await loadSigningAuthority(deployment)
        await assertUpgradeIdle()
        await NativeNamespaceIdentity.verify(proof)
        assert()
        return {
          version: 1,
          source,
          target,
          namespace: NativeNamespaceIdentity.inspect(proof),
          signingHash: digest(JSON.stringify(signing.identity)),
        }
      },
      async verify(selection, signal) {
        const assert = WorkspaceContent.captureOwner(signal)
        const { ownership, deployment } = await records()
        const current = HomeOwnershipFile.FencedInfo.parse(ownership)
        const expected = readers().target ?? readers().current
        if (
          selection.source.owner !== selected.owner ||
          selection.source.identity !== selected.identity ||
          selection.target.readerContract !== expected ||
          (JSON.stringify(current) !== JSON.stringify(selection.source) &&
            JSON.stringify(current) !== JSON.stringify(selection.target))
        )
          fail("Home upgrade no longer matches its original Service owner and selected reader")
        const signing = await loadSigningAuthority(deployment)
        const namespace = NativeNamespaceIdentity.Descriptor.parse({
          owner: selected.owner,
          identity: {
            kind: "service",
            orgID: deployment.orgID,
            deploymentIncarnation: deployment.deploymentIncarnation,
          },
        })
        if (
          namespace.owner !== selection.namespace.owner ||
          Object.keys(namespace.identity).length !== Object.keys(selection.namespace.identity).length ||
          Object.entries(namespace.identity).some(([key, value]) => selection.namespace.identity[key] !== value) ||
          digest(JSON.stringify(signing.identity)) !== selection.signingHash
        )
          fail("Home upgrade no longer matches its original deployment and signing identity")
        await assertUpgradeIdle()
        await HomeOwnershipFile.open({
          root: RuntimeContext.current().host.root,
          env: RuntimeContext.current().host.env,
          selected: current,
        }).advanceReader(current, { signal })
        assert()
      },
    })
  }
  export async function assertUpgradeComplete() {
    const status = (await getMigrationStatus(domain))[domain]
    const current = (await records()).ownership
    if (
      !status ||
      status.pending.length ||
      current.schemaVersion !== 2 ||
      current.readerContract !== (readers().target ?? readers().current)
    )
      fail("Home upgrade requires its complete selected reader and original central migration receipts")
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
    const primary = WorkspaceContent.captureOwner(signal)
    let open = true
    const assert = () => {
      primary()
      if (!open) fail("Service Home upgrade callback has ended")
    }
    const targetReader = readers().target ?? readers().current
    try {
      return await RuntimeMaintenance.withFrozen(
        lease,
        () =>
          request.run({ home, lease, signal, writer, assert }, async () => {
            await assertRequest()
            const result = await runMigrations({ targetDomain: domain, maintenance: true, output: "silent", signal })
            await assertRequest()
            const { ownership } = await records()
            if (ownership.schemaVersion !== 2 || ownership.readerContract !== targetReader)
              fail("Service Home migration receipt does not match its canonical ownership")
            return result
          }),
        { signal },
      )
    } finally {
      open = false
    }
  }
}
