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
import { HostedBinding, HostedIdentity, HostedHomeReaderContract, LegacyBinding } from "./home-schema"
import { runtimeHomeOrigin, runtimeIdentityDigest } from "./home"
import { MemberHomeError, readRecord, writeRecord } from "./record"

const domain = "organization-runtime-home"
const schema = z.union([LegacyBinding, HostedBinding])
const configured = RuntimeContext.state(() => ({ identity: undefined as HostedIdentity | undefined }))
const request = RuntimeContext.createAsyncContext<{
  home: string
  identity: HostedIdentity
  lease: RuntimeMaintenance.Lease
  signal?: AbortSignal
}>()

function owner() {
  const identity = configured().identity
  if (!identity) throw new MemberHomeError("Hosted Home migration requires its selected organization owner")
  const host = RuntimeContext.current().host
  if (path.resolve(host.root) !== path.join(path.resolve(host.home), ".synergy"))
    throw new MemberHomeError("Hosted Home migration requires its canonical native root")
  const selected = {
    schemaVersion: 2 as const,
    owner: "organization-runtime",
    identity: runtimeIdentityDigest(identity),
    readerContract: HostedHomeReaderContract,
  }
  return { identity, host, selected, files: HomeOwnershipFile.open({ root: host.root, env: host.env, selected }) }
}

async function records() {
  const current = owner()
  for (const directory of [current.host.home, current.host.root]) {
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new MemberHomeError("Hosted Home migration requires an independent local Home")
  }
  const ownership = await current.files.read()
  const binding = await readRecord(path.join(current.host.root, "organization.json"), schema, "identity records")
  if (
    !ownership ||
    !binding ||
    ownership.owner !== current.selected.owner ||
    ownership.identity !== current.selected.identity ||
    runtimeIdentityDigest(binding.identity) !== current.selected.identity ||
    "accountID" in binding.identity
  )
    throw new MemberHomeError("Hosted Home migration cannot adopt a missing or foreign identity")
  if (ownership.schemaVersion === 2 && ownership.readerContract !== HostedHomeReaderContract)
    throw new MemberHomeError("Hosted Home reader contract is unsupported")
  if (ownership.schemaVersion === 1 && binding.schemaVersion !== 1)
    throw new MemberHomeError("Hosted Home files have an inconsistent migration order")
  runtimeHomeOrigin(binding.origin)
  const credentials = await readCredentials(current.host.root)
  if (binding.state === "ready" && (!credentials || credentials.publicKey !== binding.publicKey))
    throw new MemberHomeError("Hosted Home migration cannot replace missing or mismatched credentials")
  return { ...current, ownership, binding }
}

async function assertRequest() {
  const input = request.getStore()
  if (!input) throw new MemberHomeError("Hosted Home upgrade requires explicit frozen native maintenance")
  const selected = owner()
  if (
    path.resolve(input.home) !== path.resolve(selected.host.home) ||
    runtimeIdentityDigest(input.identity) !== selected.selected.identity
  )
    throw new MemberHomeError("Hosted Home migration belongs to another native Home or identity")
  const info = await RuntimeMaintenance.assertHeld(input.lease)
  if (info.phase !== "frozen")
    throw new MemberHomeError("Hosted Home migration requires its current frozen writer cohort")
  input.signal?.throwIfAborted()
  return { input, selected }
}

export const hostedHomeMigration: Migration = {
  id: "20261112-hosted-home-reader-fence-v2",
  scope: "global",
  execution: "maintenance",
  description: "Fence previous hosted Home readers before publishing maintenance-capable bindings",
  async isApplied() {
    const current = await records()
    return current.ownership.schemaVersion === 2 && current.binding.schemaVersion === 2
  },
  async up(progress) {
    const { input, selected } = await assertRequest()
    await withFileLock(
      { directory: path.join(selected.host.root, "state", ".locks"), key: "hosted-home-format", signal: input.signal },
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
            HostedBinding.parse({ ...current.binding, schemaVersion: 2, readerContract: HostedHomeReaderContract }),
          )
        progress(1, 1)
      },
    )
  },
}

const migrations = [hostedHomeMigration]
export function registerHostedHomeMigration(input: HostedIdentity) {
  RuntimeContext.assertCompositionOpen("Hosted Home migration")
  const identity = HostedIdentity.parse(input)
  const prior = configured().identity
  if (prior && runtimeIdentityDigest(prior) !== runtimeIdentityDigest(identity))
    throw new MemberHomeError("Hosted Home migration owner is already selected")
  configured().identity = identity
  MigrationRegistry.register(domain, migrations)
}

export async function upgradeHostedHome(input: {
  home: string
  identity: HostedIdentity
  lease: RuntimeMaintenance.Lease
  signal?: AbortSignal
}) {
  return RuntimeMaintenance.withFrozen(
    input.lease,
    () =>
      request.run({ ...input, identity: HostedIdentity.parse(input.identity) }, async () => {
        await assertRequest()
        const result = await runMigrations({
          targetDomain: domain,
          maintenance: true,
          output: "silent",
          signal: input.signal,
        })
        const current = await records()
        if (current.ownership.schemaVersion !== 2 || current.binding.schemaVersion !== 2)
          throw new MemberHomeError("Hosted Home migration receipt does not match its canonical files")
        return result
      }),
    { signal: input.signal },
  )
}
