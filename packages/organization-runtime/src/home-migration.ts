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
} from "./home-schema"
import { runtimeHomeOrigin, runtimeIdentityDigest } from "./home"
import { MemberHomeError, readRecord, writeRecord } from "./record"

const domain = "organization-runtime-home"
const previousReader = "native-organization-ownership-v3"
const initialWorkspaceReader = "native-organization-ownership-v4"
const schema = z.union([LegacyBinding, BeforeInitialWorkspaceBinding, BeforeDurableSyncBinding, Binding])
const configured = RuntimeContext.state(() => ({ identity: undefined as RuntimeIdentity | undefined }))
const request = RuntimeContext.createAsyncContext<{
  home: string
  identity: RuntimeIdentity
  lease: RuntimeMaintenance.Lease
  signal?: AbortSignal
}>()

function owner() {
  const identity = configured().identity
  if (!identity) throw new MemberHomeError("Organization Home migration requires its selected organization owner")
  const host = RuntimeContext.current().host
  if (path.resolve(host.root) !== path.join(path.resolve(host.home), ".synergy"))
    throw new MemberHomeError("Organization Home migration requires its canonical native root")
  const selected = {
    schemaVersion: 2 as const,
    owner: "organization-runtime",
    identity: runtimeIdentityDigest(identity),
    readerContract: NativeHomeReaderContract,
  }
  return { identity, host, selected, files: HomeOwnershipFile.open({ root: host.root, env: host.env, selected }) }
}

async function records() {
  const current = owner()
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
      ![previousReader, initialWorkspaceReader, NativeHomeReaderContract].includes(ownership.readerContract)) ||
      (ownership.schemaVersion === 3 && ownership.readerContract !== NativeHomeReaderContract) ||
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
  const selected = owner()
  if (
    path.resolve(input.home) !== path.resolve(selected.host.home) ||
    runtimeIdentityDigest(input.identity) !== selected.selected.identity
  )
    throw new MemberHomeError("Organization Home migration belongs to another native Home or identity")
  const info = await RuntimeMaintenance.assertHeld(input.lease)
  if (info.phase !== "frozen")
    throw new MemberHomeError("Organization Home migration requires its current frozen writer cohort")
  if (
    info.version !== 2 ||
    JSON.stringify(info.native.target) !== JSON.stringify(HomeOwnershipFile.FencedInfo.parse(selected.selected))
  )
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
    return current.ownership.schemaVersion === 2 && current.binding.schemaVersion === 2
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
      current.ownership.schemaVersion === 2 &&
      [initialWorkspaceReader, NativeHomeReaderContract].includes(current.ownership.readerContract) &&
      current.binding.schemaVersion === 2 &&
      [initialWorkspaceReader, NativeHomeReaderContract].includes(current.binding.readerContract)
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
      current.ownership.schemaVersion === 2 &&
      current.ownership.readerContract === NativeHomeReaderContract &&
      current.binding.schemaVersion === 2 &&
      current.binding.readerContract === NativeHomeReaderContract
    )
  },
  up: organizationInitialWorkspaceReaderMigration.up,
}

const migrations = [
  organizationHomeMigration,
  organizationInitialWorkspaceReaderMigration,
  organizationDurableSyncReaderMigration,
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
          current.ownership.schemaVersion !== 2 ||
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
