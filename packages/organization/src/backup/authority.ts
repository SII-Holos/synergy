import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { StorageQueue, withStorageQueueOptions } from "@ericsanchezok/synergy-harness/storage/queue"
import { SecretEnvelope, type VaultKeyProvider } from "@ericsanchezok/synergy-harness/secrets/encrypted-store"
import {
  OrganizationProtocol,
  OrganizationCommandProtocol as Command,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "../storage/records"
import { OrganizationStoragePath as Keys } from "../storage/path"
import { prepareSigningMaterial, validateSigningMaterial, OrganizationSigningMaterial } from "../signing"
import { OrganizationServiceNative as Native } from "./service-native"
import { OrganizationInstallationReference as Reference } from "./installation-reference"
import { OrganizationLoginSessions } from "../auth/login-sessions"
import { OrganizationSourceRetirement } from "./source-retirement"
import { OrganizationCurrentPolicyReceipt, currentPolicyKey } from "./policy-records"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const Info = z.strictObject({
  reference: Reference,
  identity: Command.SigningIdentity,
  sourceIdentity: Command.SigningIdentity,
  checkpoint: AuthorityJournal.Checkpoint,
  clientDefinitionsHash: OrganizationProtocol.Digest,
  createdAt: z.number().int().nonnegative().safe(),
})
type Info = z.infer<typeof Info>
const Material = Info.extend({ version: z.literal(1), envelope: SecretEnvelope.Ciphertext })
type Material = z.infer<typeof Material>
const queue = RuntimeContext.state(() => new StorageQueue("organization.recovery-signing"))
const materialName = "signing-material.json"

function fail(message: string): never {
  throw new Error("Organization recovery authority " + message)
}
async function directory(root: string, installationID: string, create: boolean, assert: () => void) {
  let current = root
  for (const name of ["state", "organization-recovery", installationID]) {
    current = path.join(current, name)
    if (create)
      await fs.mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      })
    assert()
    const info = await fs.lstat(current)
    assert()
    if (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(current)) !== current)
      fail("requires its original private material directory")
    assert()
  }
  return path.join(current, materialName)
}
async function read(filename: string, assert: () => void): Promise<Material | undefined> {
  try {
    const before = await fs.lstat(filename)
    assert()
    if (!before.isFile() || before.isSymbolicLink() || before.size > 16 * 1024)
      fail("material is invalid or unsupported")
    const file = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      assert()
      const initial = await file.stat()
      assert()
      if (initial.dev !== before.dev || initial.ino !== before.ino || initial.size !== before.size)
        fail("material changed while opening")
      const bytes = Buffer.alloc(initial.size + 1)
      try {
        let used = 0
        for (;;) {
          const next = await file.read(bytes, used, bytes.length - used, used)
          assert()
          used += next.bytesRead
          if (used > initial.size) fail("material changed while reading")
          if (!next.bytesRead) break
        }
        const final = await file.stat()
        assert()
        const retained = await fs.lstat(filename)
        assert()
        if (
          used !== initial.size ||
          final.mtimeMs !== initial.mtimeMs ||
          final.ctimeMs !== initial.ctimeMs ||
          retained.dev !== initial.dev ||
          retained.ino !== initial.ino
        )
          fail("material changed while reading")
        return Material.parse(JSON.parse(bytes.subarray(0, used).toString("utf8")))
      } finally {
        bytes.fill(0)
      }
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}
function publicIdentity(stored: z.infer<typeof Record.SigningIdentity>) {
  return Command.SigningIdentity.parse({
    schemaVersion: 1,
    orgID: stored.orgID,
    deploymentIncarnation: stored.deploymentIncarnation,
    keyID: stored.keyID,
    publicKey: stored.publicKey,
  })
}
function authenticated(value: Material) {
  const { version: _, envelope: _envelope, ...info } = value
  return Info.parse(info)
}
function envelopeIdentity(info: Info) {
  return {
    authority: ["organization-recovery-prepared-signing-v1", hash(info)],
    id: info.reference.installationID,
  }
}

export namespace OrganizationRecoveryAuthority {
  export interface Prepared {
    readonly kind: "organization-recovery-prepared-signing"
  }
  export interface Activation {
    readonly kind: "organization-recovery-activation"
  }
  const activations = new WeakMap<Activation, { signing: OrganizationSigningMaterial; info: Info; assert(): void }>()
  const prepared = new WeakMap<
    Prepared,
    {
      info: Info
      assert(): void
      verify(): Promise<void>
      activate<T>(body: (activation: Activation) => Promise<T>): Promise<T>
    }
  >()
  export async function withActivation<T>(value: Prepared, body: (activation: Activation) => Promise<T>) {
    assertPrepared(value)
    return prepared.get(value)!.activate(body)
  }
  export function inspectActivation(value: Activation) {
    const original = activations.get(value)
    if (!original) fail("requires its original inactive signing activation")
    original.assert()
    return Info.parse(original.info)
  }
  export async function publish(value: Activation, source: OrganizationSourceRetirement.Inspection) {
    const original = activations.get(value)
    if (!original) fail("requires its original inactive signing activation")
    original.assert()
    if (!Storage.inWriteTransaction()) fail("publication requires its original restoration transaction")
    let complete = false
    return Storage.transaction(
      async () => {
        const reference = OrganizationSourceRetirement.inspect(source)
        const receipt = OrganizationCurrentPolicyReceipt.parse(
          await Storage.read(currentPolicyKey(original.info.reference.installationID)),
        )
        const history = await AuthorityJournal.inspect()
        if (
          hash(reference.target) !== hash(original.info.reference) ||
          hash(receipt.source) !== hash(reference) ||
          hash(receipt.target) !== hash(original.info.reference) ||
          hash(receipt.checkpoint) !== hash(reference.current.checkpoint) ||
          !history.covered ||
          hash(history.head) !== hash(reference.current.checkpoint)
        )
          fail("requires its actual reconstructed final current authority and source fence")
        const before = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
        const stored = Record.SigningIdentity.parse(await Storage.read(Keys.signingIdentity()))
        const info = original.info
        original.assert()
        if (
          before.orgID !== info.sourceIdentity.orgID ||
          before.deploymentIncarnation !== info.sourceIdentity.deploymentIncarnation ||
          stored.keyID !== info.sourceIdentity.keyID ||
          stored.publicKey !== info.sourceIdentity.publicKey
        )
          fail("publication requires the original restored deployment and signing identity")
        await OrganizationLoginSessions.retireLegacyLogins(before)
        original.assert()
        await Storage.write(
          Keys.signingIdentity(),
          Record.SigningIdentity.parse({
            ...info.identity,
            ...original.signing,
            schemaVersion: 2,
            historyContractHash: AuthorityJournal.definition().hash,
          }),
        )
        await Storage.write(
          Keys.deployment(),
          OrganizationProtocol.Deployment.parse({
            ...before,
            deploymentIncarnation: info.identity.deploymentIncarnation,
          }),
        )
        original.assert()
        complete = true
      },
      {
        commitGuard() {
          original.assert()
          OrganizationSourceRetirement.inspect(source)
          if (!complete) fail("signing publication did not complete")
        },
      },
    )
  }

  export function assertPrepared(value: Prepared) {
    const original = prepared.get(value)
    if (!original) fail("requires its original prepared evidence")
    original.assert()
  }
  export function describe(value: Prepared): Info {
    assertPrepared(value)
    return Info.parse(prepared.get(value)!.info)
  }
  export async function verify(value: Prepared) {
    assertPrepared(value)
    await prepared.get(value)!.verify()
    assertPrepared(value)
  }
  export function prepare(input: {
    permit: HomeRestoration.InstallPermit
    request: Native.InstallationRequest
    native: Native.Installed
    namespaceDirectory: string
    keys: VaultKeyProvider
    signal?: AbortSignal
  }): Promise<Prepared> {
    return select(input, false)
  }
  export function reopen(input: Parameters<typeof prepare>[0]): Promise<Prepared> {
    return select(input, true)
  }
  function select(input: Parameters<typeof prepare>[0], existingOnly: boolean): Promise<Prepared> {
    const provider = input.keys
    const captured = {
      permit: input.permit,
      request: Native.InstallationRequest.parse(structuredClone(input.request)),
      native: input.native,
      namespaceDirectory: input.namespaceDirectory,
      keys: Object.freeze({ current: provider.current.bind(provider), resolve: provider.resolve.bind(provider) }),
      signal: input.signal,
    }
    captured.signal?.throwIfAborted()
    HomeRestoration.assertRequest(captured.permit, captured.request)
    Native.assertInstalled(captured.native)
    return withStorageQueueOptions({ signal: captured.signal }, () =>
      queue().run(() => prepareNative(captured, existingOnly)),
    )
  }
  async function prepareNative(input: Parameters<typeof prepare>[0], existingOnly: boolean): Promise<Prepared> {
    const { permit, request, native, keys, signal } = input
    const runtime = RuntimeContext.current()
    const root = runtime.host.root
    const selected = HomeRestoration.describe(permit)
    const reference = Reference.parse({
      installationID: selected.installationID,
      incarnation: selected.incarnation,
      restoreID: selected.restoreID,
      requestHash: selected.requestHash,
      sourceHash: selected.sourceHash,
      nativeHash: request.payload.nativeHash,
    })
    const assert = () => {
      signal?.throwIfAborted()
      HomeRestoration.assertCurrent(permit)
      HomeRestoration.assertInstalledOwner(permit)
      HomeRestoration.assertRequest(permit, request)
      Native.assertInstalled(native)
      if (RuntimeContext.current() !== runtime || runtime.host.root !== root)
        fail("requires its original native Runtime")
    }
    assert()
    await Native.verifyInstalled(native)
    assert()
    const fixed = Native.inspectInstalled(native)
    if (
      selected.owner !== "organization" ||
      Native.sourceHash(fixed.namespace) !== reference.nativeHash ||
      Native.sourceHash(fixed.manifest.source) !== reference.sourceHash
    )
      fail("belongs to another original native installation")
    const receipt = await Storage.current().store.operationReceipt("storage-checkpoint:" + reference.restoreID)
    assert()
    if (!receipt || receipt.requestHash !== fixed.manifest.source.records.sha256)
      fail("requires its actual committed namespace import")
    const checkpoint = await AuthorityJournal.readArchivedCheckpoint({
      directory: input.namespaceDirectory,
      expected: fixed.manifest.source,
      keys,
      signal,
    })
    assert()
    const actual = await Storage.snapshot(async () => {
      const retained = await RuntimeMaintenance.restoration(reference.installationID)
      const held = await RuntimeMaintenance.status()
      if (
        !retained ||
        !held ||
        retained.installationID !== reference.installationID ||
        retained.incarnation !== reference.incarnation ||
        retained.restoreID !== reference.restoreID ||
        retained.requestHash !== reference.requestHash ||
        retained.sourceHash !== reference.sourceHash ||
        held.phase !== "recovery-held" ||
        held.purpose !== "organization-restore" ||
        hash(held) !== hash(retained.target) ||
        hash(await RuntimeMaintenance.operation(retained.source.maintenanceID)) !== hash(retained.source)
      )
        fail("requires its actual committed recovery hold")
      const history = await AuthorityJournal.inspect()
      if (!history.covered || !history.head) fail("requires its unchanged restored historical checkpoint")
      if (!existingOnly && hash(history.head) !== hash(checkpoint))
        fail("creating inactive material requires its unchanged restored historical checkpoint")
      if (existingOnly) {
        const current = history.head
        if (
          current.sequence < checkpoint.sequence ||
          ["journalID", "namespaceID", "contractHash", "baselineHash", "baselineEntries", "startedAt"].some(
            (field) => Reflect.get(current, field) !== Reflect.get(checkpoint, field),
          )
        )
          fail("existing inactive material belongs to another historical journal")
        if (current.sequence === checkpoint.sequence) {
          if (current.tailHash !== checkpoint.tailHash)
            fail("existing inactive material has another historical checkpoint")
        } else {
          const next = (await AuthorityJournal.entries({ after: checkpoint.sequence, limit: 1 })).items[0]
          if (!next || next.sequence !== checkpoint.sequence + 1 || next.previousHash !== checkpoint.tailHash)
            fail("existing inactive material has no original H0 continuation anchor")
        }
      }
      const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
      const stored = Record.SigningIdentity.parse(await Storage.read(Keys.signingIdentity()))
      if (
        checkpoint.namespaceID !== fixed.manifest.identity.orgID ||
        deployment.orgID !== fixed.manifest.identity.orgID ||
        deployment.deploymentIncarnation !== fixed.manifest.identity.deploymentIncarnation ||
        stored.orgID !== deployment.orgID ||
        stored.deploymentIncarnation !== deployment.deploymentIncarnation ||
        stored.historyContractHash !== checkpoint.contractHash
      )
        fail("requires its original source identity and history")
      return publicIdentity(stored)
    })
    assert()
    const clientDefinitionsHash = hash(fixed.manifest.startup.settings.clientAuthentication.clients)
    const filename = await directory(root, reference.installationID, !existingOnly, assert)
    assert()
    const existing = await read(filename, assert)
    assert()
    if (existingOnly && !existing) fail("requires existing inactive signing material")
    async function validate(value: Material) {
      const info = authenticated(value)
      if (
        hash(info.reference) !== hash(reference) ||
        hash(info.checkpoint) !== hash(checkpoint) ||
        hash(info.sourceIdentity) !== hash(actual) ||
        info.clientDefinitionsHash !== clientDefinitionsHash ||
        info.identity.orgID !== actual.orgID ||
        info.identity.deploymentIncarnation !== reference.incarnation ||
        info.identity.keyID === actual.keyID ||
        info.identity.publicKey === actual.publicKey
      )
        fail("material belongs to another original installation")
      const secret = Buffer.from(await keys.resolve(value.envelope.keyVersion))
      let plaintext: Buffer | undefined
      try {
        assert()
        plaintext = SecretEnvelope.open({
          ...envelopeIdentity(info),
          keyVersion: value.envelope.keyVersion,
          key: secret,
          envelope: value.envelope,
        })
        const signing = OrganizationSigningMaterial.parse(JSON.parse(plaintext.toString("utf8")))
        if (signing.keyID !== info.identity.keyID || signing.publicKey !== info.identity.publicKey)
          fail("material identity changed")
        await validateSigningMaterial(signing)
        assert()
      } finally {
        secret.fill(0)
        plaintext?.fill(0)
      }
      return info
    }
    let material = existing
    if (!material) {
      const signing = await prepareSigningMaterial()
      assert()
      const info = Info.parse({
        reference,
        identity: {
          ...actual,
          keyID: signing.keyID,
          publicKey: signing.publicKey,
          deploymentIncarnation: reference.incarnation,
        },
        sourceIdentity: actual,
        checkpoint,
        clientDefinitionsHash,
        createdAt: Date.now(),
      })
      const current = await keys.current()
      const secret = Buffer.from(current.key)
      const plaintext = Buffer.from(JSON.stringify(signing))
      try {
        assert()
        material = Material.parse({
          ...info,
          version: 1,
          envelope: SecretEnvelope.seal({
            ...envelopeIdentity(info),
            keyVersion: current.version,
            key: secret,
            bytes: plaintext,
          }),
        })
        await AtomicFile.writeJsonAtomic(filename, JSON.stringify(material), { durable: true, private: true })
        assert()
      } finally {
        secret.fill(0)
        plaintext.fill(0)
      }
    }
    const info = await validate(material)
    assert()
    const expected = hash(material)
    const evidence: Prepared = Object.freeze({ kind: "organization-recovery-prepared-signing" })
    prepared.set(evidence, {
      info: Info.parse(info),
      assert,
      async activate(body) {
        assert()
        const retained = await read(filename, assert)
        if (!retained || hash(retained) !== expected) fail("prepared material changed")
        await validate(retained)
        const secret = Buffer.from(await keys.resolve(retained.envelope.keyVersion))
        let plaintext: Buffer | undefined
        let open = true
        try {
          assert()
          plaintext = SecretEnvelope.open({
            ...envelopeIdentity(info),
            keyVersion: retained.envelope.keyVersion,
            key: secret,
            envelope: retained.envelope,
          })
          const signing = OrganizationSigningMaterial.parse(JSON.parse(plaintext.toString("utf8")))
          const activation: Activation = Object.freeze({ kind: "organization-recovery-activation" })
          activations.set(activation, {
            signing,
            info,
            assert() {
              if (!open) fail("activation callback has ended")
              assert()
            },
          })
          try {
            return await body(activation)
          } finally {
            activations.delete(activation)
            signing.pkcs8 = ""
          }
        } finally {
          open = false
          secret.fill(0)
          plaintext?.fill(0)
        }
      },
      async verify() {
        assert()
        await Native.verifyInstalled(native)
        assert()
        await directory(root, reference.installationID, false, assert)
        const retained = await read(filename, assert)
        if (!retained || hash(retained) !== expected) fail("prepared material changed")
        await validate(retained)
        assert()
      },
    })
    return evidence
  }
}
