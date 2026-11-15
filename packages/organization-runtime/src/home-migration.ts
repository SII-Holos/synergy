import { createHash } from "node:crypto"
import { isDeepStrictEqual as same } from "node:util"
import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { NativeNamespaceIdentity } from "@ericsanchezok/synergy-harness/lifecycle/namespace-identity"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageBootstrap } from "@ericsanchezok/synergy-harness/storage/bootstrap"
import { readStorageConfiguration } from "@ericsanchezok/synergy-harness/storage/config"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { OrganizationHostedPublication } from "./backup/publication"
import { captureCredentialRecord } from "./credentials"
import { captureRegistrationRecord } from "./registration"
import { memberEnvironment } from "./environment"
import path from "node:path"
import fs from "node:fs/promises"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { runMigrations, type Migration } from "@ericsanchezok/synergy-harness/migration"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { readCredentials } from "./credentials"
import {
  Binding,
  RuntimeIdentity,
  NativeHomeReaderContract,
  LegacyBinding,
  BeforeInitialWorkspaceBinding,
  BeforeDurableSyncBinding,
  BeforeRecoveryReaderBinding,
} from "./home-schema"
import { runtimeHomeOrigin, runtimeIdentityDigest, readRuntimeHomeForUpgrade } from "./home"
import { MemberHomeError, readRecord, writeRecord } from "./record"
import { inspectCompleted } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration-file"

const domain = "organization-runtime-home"
const previousReader = "native-organization-ownership-v3"
const initialWorkspaceReader = "native-organization-ownership-v4"
const durableSyncReader = "native-organization-ownership-v5"
const schema = z.union([
  LegacyBinding,
  BeforeInitialWorkspaceBinding,
  BeforeDurableSyncBinding,
  BeforeRecoveryReaderBinding,
  Binding,
])
const configured = RuntimeContext.state(() => ({ identity: undefined as RuntimeIdentity | undefined }))
const request = RuntimeContext.createAsyncContext<{
  home: string
  identity: RuntimeIdentity
  lease: RuntimeMaintenance.Lease
  signal?: AbortSignal
}>()

async function owner() {
  const identity = configured().identity
  if (!identity) throw new MemberHomeError("Organization Home migration requires its selected organization owner")
  const host = RuntimeContext.current().host
  if (path.resolve(host.root) !== path.join(path.resolve(host.home), ".synergy"))
    throw new MemberHomeError("Organization Home migration requires its canonical native root")
  const ordinary = {
    schemaVersion: 2 as const,
    owner: "organization-runtime",
    identity: runtimeIdentityDigest(identity),
    readerContract: NativeHomeReaderContract,
  }
  const original = await HomeOwnershipFile.open({ root: host.root, env: host.env, selected: ordinary }).read()
  if (original?.schemaVersion === 3) {
    const completed = await inspectCompleted({ home: host.home, root: host.root, env: host.env })
    if (
      completed.owner !== original.owner ||
      completed.installationID !== original.installationID ||
      completed.incarnation !== original.incarnation
    )
      throw new MemberHomeError("Home upgrade has another completed installation")
    const selected = HomeOwnershipFile.RestorationInfo.parse({ ...original, readerContract: NativeHomeReaderContract })
    return { identity, host, selected, files: HomeOwnershipFile.open({ root: host.root, env: host.env, selected }) }
  }
  return {
    identity,
    host,
    selected: ordinary,
    files: HomeOwnershipFile.open({ root: host.root, env: host.env, selected: ordinary }),
  }
}

async function records() {
  const current = await owner()
  for (const directory of [current.host.home, current.host.root]) {
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new MemberHomeError("Organization Home migration requires an independent local Home")
  }
  const ownership = await current.files.read()
  const binding = await readRecord(path.join(current.host.root, "organization.json"), schema, "identity records")
  if (
    !ownership ||
    !binding ||
    ownership.owner !== current.selected.owner ||
    ownership.identity !== current.selected.identity ||
    runtimeIdentityDigest(binding.identity) !== current.selected.identity
  )
    throw new MemberHomeError("Organization Home migration cannot adopt a missing or foreign identity")
  if (
    ownership.schemaVersion !== 1 &&
    ((ownership.schemaVersion === 2 &&
      ![previousReader, initialWorkspaceReader, durableSyncReader, NativeHomeReaderContract].includes(
        ownership.readerContract,
      )) ||
      (ownership.schemaVersion === 3 &&
        ![durableSyncReader, NativeHomeReaderContract].includes(ownership.readerContract)) ||
      ownership.schemaVersion === 4)
  )
    throw new MemberHomeError("Organization Home reader contract is unsupported")
  if (
    (ownership.schemaVersion === 1 && binding.schemaVersion !== 1) ||
    (ownership.schemaVersion === 2 &&
      ((ownership.readerContract !== NativeHomeReaderContract && binding.schemaVersion !== 2) ||
        (binding.schemaVersion === 2 &&
          ((ownership.readerContract === previousReader && binding.readerContract !== previousReader) ||
            (ownership.readerContract === initialWorkspaceReader &&
              binding.readerContract !== previousReader &&
              binding.readerContract !== initialWorkspaceReader)))))
  )
    throw new MemberHomeError("Organization Home files have an inconsistent migration order")
  runtimeHomeOrigin(binding.origin)
  const credentials = await readCredentials(current.host.root)
  if (binding.state === "ready" && (!credentials || credentials.publicKey !== binding.publicKey))
    throw new MemberHomeError("Organization Home migration cannot replace missing or mismatched credentials")
  return { ...current, ownership, binding }
}

async function assertRequest() {
  const input = request.getStore()
  if (!input) throw new MemberHomeError("Organization Home upgrade requires explicit frozen native maintenance")
  const selected = await owner()
  if (
    path.resolve(input.home) !== path.resolve(selected.host.home) ||
    runtimeIdentityDigest(input.identity) !== selected.selected.identity
  )
    throw new MemberHomeError("Organization Home migration belongs to another native Home or identity")
  const info = await RuntimeMaintenance.assertHeld(input.lease)
  if (info.phase !== "frozen")
    throw new MemberHomeError("Organization Home migration requires its current frozen writer cohort")
  if (info.version !== 2 || JSON.stringify(info.native.target) !== JSON.stringify(selected.selected))
    throw new MemberHomeError("The retained native Home upgrade target is unsupported by this reader")
  input.signal?.throwIfAborted()
  return { input, selected }
}

export const organizationHomeMigration: Migration = {
  id: "20261112-organization-home-reader-fence-v2",
  scope: "global",
  execution: "maintenance",
  description: "Fence previous organization Home readers before publishing native ownership bindings",
  async isApplied() {
    const current = await records()
    return [2, 3].includes(current.ownership.schemaVersion) && current.binding.schemaVersion === 2
  },
  async up(progress) {
    const { input, selected } = await assertRequest()
    await withFileLock(
      {
        directory: path.join(selected.host.root, "state", ".locks"),
        key: "organization-home-format",
        signal: input.signal,
      },
      async () => {
        await assertRequest()
        const current = await records()
        await current.files.upgrade(
          {
            schemaVersion: 1,
            owner: current.selected.owner,
            identity: current.selected.identity,
          },
          { signal: input.signal },
        )
        input.signal?.throwIfAborted()
        if (current.binding.schemaVersion === 1)
          await writeRecord(
            path.join(current.host.root, "organization.json"),
            Binding.parse({ ...current.binding, schemaVersion: 2, readerContract: NativeHomeReaderContract }),
          )
        progress(1, 1)
      },
    )
  },
}

export const organizationInitialWorkspaceReaderMigration: Migration = {
  id: "20261113-organization-initial-workspace-home-reader-v4",
  scope: "global",
  execution: "maintenance",
  dependsOn: [organizationHomeMigration.id],
  description: "Fence previous Runtime readers before retaining initial cloud Workspace provenance",
  async isApplied() {
    const current = await records()
    return (
      (current.ownership.schemaVersion === 2 || current.ownership.schemaVersion === 3) &&
      [initialWorkspaceReader, durableSyncReader, NativeHomeReaderContract].includes(
        current.ownership.readerContract,
      ) &&
      current.binding.schemaVersion === 2 &&
      [initialWorkspaceReader, durableSyncReader, NativeHomeReaderContract].includes(current.binding.readerContract)
    )
  },
  async up(progress) {
    const { input, selected } = await assertRequest()
    await withFileLock(
      {
        directory: path.join(selected.host.root, "state", ".locks"),
        key: "organization-home-format",
        signal: input.signal,
      },
      async () => {
        await assertRequest()
        const current = await records()
        if (current.ownership.schemaVersion !== 2 || current.binding.schemaVersion !== 2)
          throw new MemberHomeError("Organization initial Workspace reader requires its previous fenced Home")
        const physical = await current.files.physicalHash()
        await current.files.advanceReader(current.ownership, { signal: input.signal })
        await assertRequest()
        const retained = await records()
        if (
          (await current.files.physicalHash()) !== physical ||
          JSON.stringify(retained.binding) !== JSON.stringify(current.binding)
        )
          throw new MemberHomeError("Organization initial Workspace reader lost its original Home binding")
        if (current.binding.readerContract !== NativeHomeReaderContract)
          await writeRecord(
            path.join(current.host.root, "organization.json"),
            Binding.parse({ ...current.binding, readerContract: NativeHomeReaderContract }),
          )
        await assertRequest()
        if ((await current.files.physicalHash()) !== physical)
          throw new MemberHomeError("Organization initial Workspace reader lost its original native Home")
        const completed = await records()
        if (
          completed.ownership.schemaVersion !== 2 ||
          completed.ownership.readerContract !== NativeHomeReaderContract ||
          completed.binding.schemaVersion !== 2 ||
          JSON.stringify(completed.binding) !==
            JSON.stringify({ ...current.binding, readerContract: NativeHomeReaderContract })
        )
          throw new MemberHomeError("Organization initial Workspace reader did not retain its original identity")
        progress(1, 1)
      },
    )
  },
}

export const organizationDurableSyncReaderMigration: Migration = {
  id: "20261114-organization-durable-sync-home-reader-v5",
  scope: "global",
  execution: "maintenance",
  dependsOn: [organizationInitialWorkspaceReaderMigration.id],
  description: "Fence previous Runtime readers before accepting durable native sync delivery",
  async isApplied() {
    const current = await records()
    return (
      (current.ownership.schemaVersion === 2 || current.ownership.schemaVersion === 3) &&
      [durableSyncReader, NativeHomeReaderContract].includes(current.ownership.readerContract) &&
      current.binding.schemaVersion === 2 &&
      [durableSyncReader, NativeHomeReaderContract].includes(current.binding.readerContract)
    )
  },
  up: organizationInitialWorkspaceReaderMigration.up,
}

export const organizationRecoveryReaderMigration: Migration = {
  id: "20261116-organization-restoration-continuation-home-reader-v6",
  scope: "global",
  execution: "maintenance",
  dependsOn: [organizationDurableSyncReaderMigration.id],
  description: "Fence original readers while preserving a completed native restoration identity",
  async isApplied() {
    const current = await records()
    return (
      (current.ownership.schemaVersion === 2 || current.ownership.schemaVersion === 3) &&
      current.ownership.readerContract === NativeHomeReaderContract &&
      current.binding.schemaVersion === 2 &&
      current.binding.readerContract === NativeHomeReaderContract
    )
  },
  async up(progress) {
    const { input, selected } = await assertRequest()
    await withFileLock(
      {
        directory: path.join(selected.host.root, "state", ".locks"),
        key: "organization-home-format",
        signal: input.signal,
      },
      async () => {
        await assertRequest()
        const current = await records()
        if (
          (current.ownership.schemaVersion !== 2 && current.ownership.schemaVersion !== 3) ||
          current.binding.schemaVersion !== 2
        )
          throw new MemberHomeError("Reader advancement requires its original native owner")
        const physical = await current.files.physicalHash()
        const expected = { ...current.ownership, readerContract: NativeHomeReaderContract }
        await current.files.advanceReader(current.ownership, { signal: input.signal })
        await writeRecord(
          path.join(current.host.root, "organization.json"),
          Binding.parse({ ...current.binding, readerContract: NativeHomeReaderContract }),
        )
        await assertRequest()
        const completed = await records()
        if (
          (await current.files.physicalHash()) !== physical ||
          JSON.stringify(completed.ownership) !== JSON.stringify(expected) ||
          JSON.stringify(completed.binding) !==
            JSON.stringify({ ...current.binding, readerContract: NativeHomeReaderContract })
        )
          throw new MemberHomeError("Reader advancement changed its original native installation or binding")
        progress(1, 1)
      },
    )
  },
}

const migrations = [
  organizationHomeMigration,
  organizationInitialWorkspaceReaderMigration,
  organizationDurableSyncReaderMigration,
  organizationRecoveryReaderMigration,
]
export function registerOrganizationHomeMigration(input: RuntimeIdentity) {
  RuntimeContext.assertCompositionOpen("Organization Home migration")
  const identity = RuntimeIdentity.parse(input)
  const prior = configured().identity
  if (prior && runtimeIdentityDigest(prior) !== runtimeIdentityDigest(identity))
    throw new MemberHomeError("Organization Home migration owner is already selected")
  configured().identity = identity
  MigrationRegistry.register(domain, migrations)
}

export async function upgradeOrganizationHome(input: {
  home: string
  identity: RuntimeIdentity
  lease: RuntimeMaintenance.Lease
  signal?: AbortSignal
}) {
  return RuntimeMaintenance.withFrozen(
    input.lease,
    () =>
      request.run({ ...input, identity: RuntimeIdentity.parse(input.identity) }, async () => {
        await assertRequest()
        const result = await runMigrations({
          targetDomain: domain,
          maintenance: true,
          output: "silent",
          signal: input.signal,
        })
        const current = await records()
        if (
          (current.ownership.schemaVersion !== 2 && current.ownership.schemaVersion !== 3) ||
          current.ownership.readerContract !== NativeHomeReaderContract ||
          current.binding.schemaVersion !== 2 ||
          current.binding.readerContract !== NativeHomeReaderContract
        )
          throw new MemberHomeError("Organization Home migration receipt does not match its canonical files")
        return result
      }),
    { signal: input.signal },
  )
}

export async function upgradeOrganizationRuntimeHome(input: {
  home: string
  identity: RuntimeIdentity
  requestID: string
  environment?: Readonly<Record<string, string | undefined>>
  signal?: AbortSignal
}) {
  const requestID = z.string().min(1).max(128).parse(input.requestID)
  const identity = RuntimeIdentity.parse(input.identity)
  const signal = input.signal
  signal?.throwIfAborted()
  const member = await readRuntimeHomeForUpgrade(input.home, identity)
  const environment = input.environment ?? process.env
  const configuration = await readStorageConfiguration(member.root)
  if (configuration.backend !== "sqlite")
    throw new MemberHomeError("Native Home reader upgrade requires its original SQLite dataset")
  const context = RuntimeContext.create(
    {
      home: member.home,
      root: member.root,
      env: memberEnvironment(member, environment),
    },
    "oneshot",
  )
  return context.run(async () => {
    const ownerID = "organization-runtime-home-upgrade"
    let writer: Awaited<ReturnType<typeof ServerProcessLock.acquire>> | undefined
    let store: Awaited<ReturnType<typeof StorageBootstrap.openExisting>>["store"] | undefined
    let failure: unknown
    let failed = false
    try {
      HomeOwnership.select(member.ownership)
      HomeRestoration.register()
      OrganizationHostedPublication.register(member.restoration)
      RuntimeMaintenance.registerProtection()
      writer = await ServerProcessLock.acquire()
      const attached = await StorageBootstrap.openExisting(member.root)
      store = attached.store
      context.storage = { store, artifactDirectory: attached.artifactDirectory }
      const initial = await readRuntimeHomeForUpgrade(member.home, identity)
      if (!same(initial, member))
        throw new MemberHomeError("Native Home reader upgrade changed while acquiring its writer")
      const enrollment = (await captureRegistrationRecord(member))?.value.registration
      if (!enrollment) throw new MemberHomeError("Native Home reader upgrade requires its enrolled namespace")
      const namespace = async () => {
        const current = await readRuntimeHomeForUpgrade(member.home, identity)
        const actual = (await captureRegistrationRecord(current))?.value.registration
        if (!same({ ...current.binding, readerContract: member.binding.readerContract }, member.binding))
          throw new MemberHomeError("Native Home reader upgrade changed its original binding")
        if (!actual || !same(actual, enrollment))
          throw new MemberHomeError("Native Home reader upgrade changed its enrolled namespace")
        return {
          kind: actual.runtimeKind,
          orgID: actual.orgID,
          deploymentIncarnation: actual.deploymentIncarnation,
          runtimeID: actual.runtimeID,
          publicKey: actual.publicKey,
        }
      }
      const signingHash = async () => {
        const selected = await captureCredentialRecord(member.root)
        return createHash("sha256").update(selected.bytes).digest("hex")
      }
      NativeNamespaceIdentity.register({ owner: "organization-runtime", read: namespace })
      RuntimeMaintenance.configure({ required: [ownerID] })
      RuntimeMaintenance.register(ownerID, {
        version: 1,
        async suspend(current) {
          await RuntimeMaintenance.assertDraining(current.lease)
        },
        async drain(current) {
          await RuntimeMaintenance.assertDraining(current.lease)
        },
        async inspect() {
          return []
        },
        async reconcileFrozen(current) {
          await RuntimeMaintenance.assertNativeReconciliation(current.lease, "frozen")
        },
        async reconcileReleasing(current) {
          await RuntimeMaintenance.assertNativeReconciliation(current.lease, "releasing")
        },
        async release(current) {
          await RuntimeMaintenance.assertReleasing(current.lease)
        },
        async released(current) {
          await RuntimeMaintenance.assertReleased(current.lease)
        },
      })
      RuntimeMaintenance.registerHomeUpgradeOwner(ownerID, {
        version: 1,
        async capture() {
          await HomeRestoration.assertOrdinaryStartup()
          const proof = await NativeNamespaceIdentity.capture()
          const current = await readRuntimeHomeForUpgrade(member.home, identity)
          if (current.ownership.readerContract !== current.binding.readerContract)
            throw new MemberHomeError("Interrupted Home reader advancement requires its original maintenance request")
          const source = current.ownership
          const target = { ...source, readerContract: NativeHomeReaderContract }
          await NativeNamespaceIdentity.verify(proof)
          return RuntimeMaintenance.HomeUpgradeSelection.parse({
            version: source.schemaVersion === 3 ? 2 : 1,
            source,
            target,
            namespace: NativeNamespaceIdentity.inspect(proof),
            signingHash: await signingHash(),
          })
        },
        async verify(selection) {
          const current = await readRuntimeHomeForUpgrade(member.home, identity)
          if (
            (selection.source.readerContract !== durableSyncReader &&
              selection.source.readerContract !== NativeHomeReaderContract) ||
            selection.target.readerContract !== NativeHomeReaderContract ||
            selection.source.owner !== "organization-runtime" ||
            selection.source.identity !== runtimeIdentityDigest(identity) ||
            (!same(current.ownership, selection.source) && !same(current.ownership, selection.target)) ||
            !same(selection.namespace, { owner: "organization-runtime", identity: await namespace() }) ||
            selection.signingHash !== (await signingHash())
          )
            throw new MemberHomeError("Native Home reader upgrade lost its original selection or credentials")
        },
      })
      registerOrganizationHomeMigration(identity)
      MigrationRegistry.lock()
      RuntimeContext.sealComposition()
      const perform = async (lease: RuntimeMaintenance.Lease) => {
        let held =
          (await RuntimeMaintenance.status())?.phase === "released"
            ? await RuntimeMaintenance.assertReleased(lease)
            : await RuntimeMaintenance.assertHeld(lease)
        if (held.phase === "draining") {
          await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease, { signal }))
          held = await RuntimeMaintenance.assertHeld(lease)
        }
        if (held.phase === "frozen") await upgradeOrganizationHome({ home: member.home, identity, lease, signal })
        const completed = await readRuntimeHomeForUpgrade(member.home, identity)
        if (
          completed.ownership.readerContract !== NativeHomeReaderContract ||
          completed.binding.readerContract !== NativeHomeReaderContract
        )
          throw new MemberHomeError("Native Home reader upgrade has not completed both original files")
        await HomeRestoration.assertOrdinaryStartup()
        const released = await RuntimeMaintenance.release(lease, { signal })
        if (released.version !== 2 || !same(released.native.target, completed.ownership))
          throw new MemberHomeError("Native Home reader upgrade lost its exact released target")
        return {
          state: "upgrade-complete" as const,
          restartRequired: true,
          executesAgents: false,
          schemaVersion: completed.ownership.schemaVersion,
          readerContract: NativeHomeReaderContract,
          requestID,
          maintenanceID: released.maintenanceID,
        }
      }
      const current = await RuntimeMaintenance.status()
      if (current?.requestID === requestID)
        return await RuntimeMaintenance.withHomeUpgradeRecovery({ requestID, signal }, perform)
      if (initial.ownership.readerContract !== initial.binding.readerContract)
        throw new MemberHomeError("Interrupted Home reader advancement requires its original maintenance request")
      const lease = await RuntimeMaintenance.begin({
        purpose: "organization-home-upgrade",
        requestID,
        signal,
        actor: {
          kind: "system",
          subjectID: "organization-runtime-home-upgrade",
          displayName: "Runtime Home upgrade",
          clientKind: "system",
          requestID,
        },
      })
      return await perform(lease)
    } catch (error) {
      failed = true
      failure = error
      throw error
    } finally {
      const cleanup: unknown[] = []
      for (const close of [
        async () => {
          if (store) {
            Storage.closeArtifactAdmission()
            await Storage.drainArtifactPreparations()
          }
        },
        () => store?.close(),
        () => writer?.release(),
      ]) {
        try {
          await close()
        } catch (error) {
          cleanup.push(error)
        }
      }
      context.dispose()
      if (cleanup.length) {
        if (failed) throw new AggregateError([failure, ...cleanup], "Native Home reader upgrade and cleanup failed")
        throw new AggregateError(cleanup, "Native Home reader upgrade cleanup failed")
      }
    }
  })
}
