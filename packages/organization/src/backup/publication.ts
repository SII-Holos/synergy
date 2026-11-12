import { createHash } from "node:crypto"
import { z } from "zod"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageMutationGuard } from "@ericsanchezok/synergy-harness/storage/mutation-guard"
import type { StoreTransaction } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { OrganizationRecoveryAuthority as Authority } from "./authority"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import {
  OrganizationCommandProtocol as Command,
  OrganizationProtocol,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "../storage/records"
import { OrganizationStoragePath as Keys } from "../storage/path"
import { OrganizationInstallationReference } from "./installation-reference"
import { OrganizationSourceRetirement } from "./source-retirement"
import { OrganizationServiceNative as Native } from "./service-native"
import { OrganizationCurrentPolicyReceipt, currentPolicyKey } from "./policy-records"
import { OrganizationRecoveryWriters as Writers } from "./writers"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const key = (id: string) => ["organization-recovery", "publication", id]
const Receipt = z
  .strictObject({
    version: z.union([z.literal(1), z.literal(2)]),
    target: OrganizationInstallationReference,
    source: OrganizationSourceRetirement.Reference,
    checkpoint: AuthorityJournal.Checkpoint,
    identity: Command.SigningIdentity,
    settings: Native.Manifest.shape.startup.shape.settings,
    publicOrigin: z.string().url(),
    publishedAt: z.number().int().nonnegative().safe(),
    writers: z
      .strictObject({ hosted: z.number().int().nonnegative().safe(), namespaceHash: OrganizationProtocol.Digest })
      .optional(),
  })
  .refine(
    (value) => (value.version === 1) === (value.writers === undefined),
    "Hosted writer publication requires its versioned receipt",
  )
const hostedKey = (id: string, runtimeID: string) => [...key(id), "hosted", runtimeID]
const Hosted = z.strictObject({
  version: z.literal(1),
  target: OrganizationInstallationReference,
  namespaceHash: OrganizationProtocol.Digest,
  sourceReferenceHash: OrganizationProtocol.Digest,
  original: Runtime.HostedRegistrationRecord,
  published: Runtime.HostedRegistrationRecord,
})
function fail(message: string): never {
  throw new Error("Organization recovery publication " + message)
}
const writes = RuntimeContext.createAsyncContext<{ tx: StoreTransaction; key: string[]; assert(): void }>()
const failed = new WeakSet<Promise<void>>()
const pending = RuntimeContext.state(() => new Map<string, Promise<void>>())
async function writeHosted(tx: StoreTransaction, evidence: Writers.Inspection, receipt: z.infer<typeof Receipt>) {
  const summary = Writers.inspect(evidence)
  if (
    !receipt.writers ||
    receipt.writers.hosted !== summary.hosted ||
    receipt.writers.namespaceHash !== summary.namespaceHash
  )
    fail("requires its original complete Hosted roster")
  let count = 0
  for (const source of Writers.hosted(evidence)) {
    const { schemaVersion: _, ...original } = source.registration
    const published = Runtime.HostedRegistrationRecord.parse({
      ...original,
      deploymentIncarnation: receipt.target.incarnation,
      revision: original.revision + 1,
    })
    const mapping = Hosted.parse({
      version: 1,
      target: receipt.target,
      namespaceHash: summary.namespaceHash,
      sourceReferenceHash: source.sourceReferenceHash,
      original,
      published,
    })
    const address = hostedKey(receipt.target.installationID, original.runtimeID)
    const [previous] = await tx.readMany([address])
    if (previous !== undefined && hash(Hosted.parse(previous)) !== hash(mapping))
      fail("cannot replace its original Hosted mapping")
    if (previous === undefined)
      await writes.run(
        {
          tx,
          key: address,
          assert() {
            Writers.inspect(evidence)
          },
        },
        () => tx.write(address, mapping),
      )
    count++
  }
  if (
    count !== summary.hosted ||
    (await Storage.count({ prefix: [...key(receipt.target.installationID), "hosted"] })) !== count
  )
    fail("Hosted publication does not cover its complete roster")
}

export namespace OrganizationRecoveryPublication {
  export type Receipt = z.infer<typeof Receipt>
  export async function read(installationID: string) {
    const receipt = Receipt.parse(await Storage.read(key(installationID)))
    if (
      receipt.target.installationID !== installationID ||
      hash(receipt.target) !== hash(receipt.source.target) ||
      hash(receipt.checkpoint) !== hash(receipt.source.current.checkpoint) ||
      receipt.identity.deploymentIncarnation !== receipt.target.incarnation
    )
      fail("receipt differs from its original source and target")
    if (receipt.writers && receipt.writers.namespaceHash !== receipt.source.current.namespaceHash)
      fail("writer roster belongs to another H1 namespace")
    return receipt
  }
  export async function write(
    tx: StoreTransaction,
    input: {
      activation: Authority.Activation
      source: OrganizationSourceRetirement.Inspection
      native: Native.PublicationSettings
      publicOrigin: string
      writers?: Writers.Inspection
    },
  ) {
    const { activation, source, native, publicOrigin, writers } = input
    const origin = new URL(publicOrigin)
    if (origin.origin !== publicOrigin || origin.protocol !== "https:") fail("requires an explicit HTTPS origin")
    const assert = () => {
      Authority.inspectActivation(activation)
      OrganizationSourceRetirement.inspect(source)
      Native.inspectPublicationSettings(native)
      if (writers) Writers.inspect(writers)
    }
    assert()
    if (Storage.current().transaction !== tx || !Storage.inWriteTransaction())
      fail("requires its actual publication transaction")
    const info = Authority.inspectActivation(activation)
    const reference = OrganizationSourceRetirement.inspect(source)
    const settings = Native.inspectPublicationSettings(native)
    const reconciled = writers && Writers.inspect(writers)
    if (
      hash(info.reference) !== hash(reference.target) ||
      Native.sourceHash(settings.namespace) !== reference.current.nativeHash ||
      Native.sourceHash(settings.manifest.source) !== reference.current.namespaceHash ||
      hash(settings.manifest.startup.settings.clientAuthentication.clients) !==
        reference.current.clientDefinitionsHash ||
      settings.manifest.startup.requirements.length ||
      settings.manifest.startup.webRequired
    )
      fail("requires the original verified source settings, target and prepared key")
    if (
      reconciled &&
      (hash(reconciled.target) !== hash(info.reference) || reconciled.namespaceHash !== reference.current.namespaceHash)
    )
      fail("requires its original complete H1 writer inspection")
    const receipt = Receipt.parse({
      version: reconciled ? 2 : 1,
      target: info.reference,
      source: reference,
      checkpoint: reference.current.checkpoint,
      identity: info.identity,
      settings: settings.manifest.startup.settings,
      publicOrigin,
      publishedAt: Date.now(),
      ...(reconciled ? { writers: { hosted: reconciled.hosted, namespaceHash: reconciled.namespaceHash } } : {}),
    })
    const address = key(receipt.target.installationID)
    let complete = false
    return Storage.transaction(
      async () => {
        const policy = OrganizationCurrentPolicyReceipt.parse(
          await Storage.read(currentPolicyKey(info.reference.installationID)),
        )
        if (
          hash(policy.source) !== hash(reference) ||
          hash(policy.target) !== hash(info.reference) ||
          hash(policy.checkpoint) !== hash(reference.current.checkpoint)
        )
          fail("requires its committed original current-policy reconstruction")
        const [retained] = await tx.readMany([address])
        assert()
        if (retained !== undefined) {
          const previous = Receipt.parse(retained)
          if (hash(previous) !== hash({ ...receipt, publishedAt: previous.publishedAt }))
            fail("cannot replace its original publication")
          const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
          const signer = Record.SigningIdentity.parse(await Storage.read(Keys.signingIdentity()))
          if (
            deployment.orgID !== previous.identity.orgID ||
            deployment.deploymentIncarnation !== previous.identity.deploymentIncarnation ||
            signer.keyID !== previous.identity.keyID ||
            signer.publicKey !== previous.identity.publicKey
          )
            fail("existing publication does not match its canonical authority")
          assert()
          if (writers) {
            await Writers.publish(writers, tx)
            await writeHosted(tx, writers, previous)
          }
          complete = true
          return previous
        }
        await Authority.publish(activation, source)
        assert()
        if (writers) {
          await Writers.publish(writers, tx)
          await writeHosted(tx, writers, receipt)
        }
        await writes.run({ tx, key: address, assert }, () => tx.write(address, receipt))
        assert()
        complete = true
        return receipt
      },
      {
        commitGuard() {
          assert()
          if (writers) Writers.assertPublished(writers, tx)
          if (!complete) fail("publication write did not complete")
        },
      },
    )
  }
  export function register() {
    StorageMutationGuard.register("organization-recovery-publication", async (tx, keys, tree) => {
      const prefix = ["organization-recovery", "publication"]
      const overlaps = (key: string[]) =>
        prefix.every((part, index) => key[index] === part) ||
        (tree && key.every((part, index) => prefix[index] === part))
      for (const key of keys.filter(overlaps)) {
        const current = writes.getStore()
        if (!current || current.tx !== tx || tree || hash(current.key) !== hash(key))
          fail("records require their owning publication transaction")
        current.assert()
      }
    })
    HomeRestoration.registerPublicationOwner("organization", {
      async read(info) {
        const receipt = await read(info.installationID)
        if (
          info.owner !== "organization" ||
          info.installationID !== receipt.target.installationID ||
          info.incarnation !== receipt.target.incarnation ||
          info.restoreID !== receipt.target.restoreID ||
          info.requestHash !== receipt.target.requestHash ||
          info.sourceHash !== receipt.target.sourceHash
        )
          fail("belongs to another native installation")
        const released = await Storage.snapshot(async () => {
          const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
          const signer = Record.SigningIdentity.parse(await Storage.read(Keys.signingIdentity()))
          if (
            deployment.orgID !== receipt.identity.orgID ||
            deployment.deploymentIncarnation !== receipt.identity.deploymentIncarnation ||
            signer.orgID !== receipt.identity.orgID ||
            signer.deploymentIncarnation !== receipt.identity.deploymentIncarnation ||
            signer.keyID !== receipt.identity.keyID ||
            signer.publicKey !== receipt.identity.publicKey ||
            signer.historyContractHash !== AuthorityJournal.definition().hash
          )
            fail("does not match its committed signing authority")
          const restored = await RuntimeMaintenance.restoration(info.installationID)
          const held = await RuntimeMaintenance.operation(info.installationID)
          if (
            !restored ||
            !held ||
            held.maintenanceID !== info.installationID ||
            restored.requestHash !== info.requestHash ||
            restored.incarnation !== info.incarnation ||
            !["recovery-held", "released"].includes(held.phase)
          )
            fail("requires its original maintenance installation")
          if (
            hash(held) !==
            hash({
              ...restored.target,
              ...(held.phase === "released"
                ? { phase: "released", revision: restored.target.revision + 1, updatedAt: held.updatedAt }
                : {}),
            })
          )
            fail("maintenance publication differs from its original release")
          return held.phase === "released"
        })
        return {
          publicationHash: hash(receipt),
          nativeReady: await Native.publicationReady(receipt.settings, released),
          released,
        }
      },
      async inspect(info, subject) {
        return Storage.snapshot(async () => {
          const receipt = await read(info.installationID)
          if (
            !receipt.writers ||
            info.incarnation !== receipt.target.incarnation ||
            info.requestHash !== receipt.target.requestHash ||
            info.sourceHash !== receipt.target.sourceHash ||
            info.restoreID !== receipt.target.restoreID
          )
            fail("requires the original Hosted recovery publication")
          const mapping = Hosted.parse(await Storage.read(hostedKey(info.installationID, subject)))
          const current = Record.RuntimeRegistration.parse(await Storage.read(Keys.runtime(subject)))
          if (
            hash(mapping.target) !== hash(receipt.target) ||
            mapping.namespaceHash !== receipt.writers.namespaceHash ||
            current.runtimeKind !== "hosted" ||
            current.runtimeID !== mapping.published.runtimeID ||
            current.runtimeID !== subject ||
            current.orgID !== mapping.published.orgID ||
            current.deploymentIncarnation !== receipt.target.incarnation ||
            current.publicKey !== mapping.published.publicKey ||
            current.createdAt !== mapping.published.createdAt ||
            current.createdBy !== mapping.published.createdBy ||
            current.revision < mapping.published.revision ||
            current.connectionEpoch < mapping.published.connectionEpoch ||
            (mapping.original.state !== "active" && current.state !== mapping.original.state) ||
            (current.state === "pending" && mapping.original.state === "active")
          )
            fail("canonical Hosted registration differs from its original publication")
          const { schemaVersion: _, ...registration } = current
          return {
            kind: "organization-hosted-recovery",
            target: receipt.target,
            sourceReferenceHash: mapping.sourceReferenceHash,
            registration,
          }
        })
      },
    })
  }
  export async function withPublishedHosted<T>(
    input: { installationID: string; runtimeID: string },
    body: (inspection: HomeRestoration.PublicationInspection) => Promise<T>,
  ) {
    const { installationID, runtimeID } = input
    const receipt = await read(installationID)
    return HomeRestoration.withPublication({ installationID, publicationHash: hash(receipt) }, (permit) =>
      HomeRestoration.withPublicationInspection(permit, runtimeID, body),
    )
  }
  export function complete(installationID: string) {
    const running = pending().get(installationID)
    if (running && !failed.has(running)) return running
    const work = (async () => {
      const receipt = await read(installationID)
      await HomeRestoration.withPublication({ installationID, publicationHash: hash(receipt) }, async (permit) => {
        if ((await HomeRestoration.verifyPublication(permit)).released) return
        await Native.publishSettings(permit, receipt.settings)
        await HomeRestoration.completePublication(permit)
        await RuntimeMaintenance.releaseRestoration(permit)
      })
    })()
    pending().set(installationID, work)
    void work.catch(() => {
      failed.add(work)
    })
    return work
  }
  export async function drain() {
    const results = await Promise.allSettled(pending().values())
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, "Restored native publication did not complete")
  }
}
