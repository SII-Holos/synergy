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
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "../storage/records"
import { OrganizationStoragePath as Keys } from "../storage/path"
import { OrganizationInstallationReference } from "./installation-reference"
import { OrganizationSourceRetirement } from "./source-retirement"
import { OrganizationServiceNative as Native } from "./service-native"
import { OrganizationCurrentPolicyReceipt, currentPolicyKey } from "./policy-records"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const key = (id: string) => ["organization-recovery", "publication", id]
const Receipt = z.strictObject({
  version: z.literal(1),
  target: OrganizationInstallationReference,
  source: OrganizationSourceRetirement.Reference,
  checkpoint: AuthorityJournal.Checkpoint,
  identity: Command.SigningIdentity,
  settings: Native.Manifest.shape.startup.shape.settings,
  publicOrigin: z.string().url(),
  publishedAt: z.number().int().nonnegative().safe(),
})
function fail(message: string): never {
  throw new Error("Organization recovery publication " + message)
}
const writes = RuntimeContext.createAsyncContext<{ tx: StoreTransaction; key: string[]; assert(): void }>()
const failed = new WeakSet<Promise<void>>()
const pending = RuntimeContext.state(() => new Map<string, Promise<void>>())

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
    return receipt
  }
  export async function write(
    tx: StoreTransaction,
    input: {
      activation: Authority.Activation
      source: OrganizationSourceRetirement.Inspection
      native: Native.PublicationSettings
      publicOrigin: string
    },
  ) {
    const { activation, source, native, publicOrigin } = input
    const origin = new URL(publicOrigin)
    if (origin.origin !== publicOrigin || origin.protocol !== "https:") fail("requires an explicit HTTPS origin")
    const assert = () => {
      Authority.inspectActivation(activation)
      OrganizationSourceRetirement.inspect(source)
      Native.inspectPublicationSettings(native)
    }
    assert()
    if (Storage.current().transaction !== tx || !Storage.inWriteTransaction())
      fail("requires its actual publication transaction")
    const info = Authority.inspectActivation(activation)
    const reference = OrganizationSourceRetirement.inspect(source)
    const settings = Native.inspectPublicationSettings(native)
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
    const receipt = Receipt.parse({
      version: 1,
      target: info.reference,
      source: reference,
      checkpoint: reference.current.checkpoint,
      identity: info.identity,
      settings: settings.manifest.startup.settings,
      publicOrigin,
      publishedAt: Date.now(),
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
          complete = true
          return previous
        }
        await Authority.publish(activation, source)
        assert()
        await writes.run({ tx, key: address, assert }, () => tx.write(address, receipt))
        assert()
        complete = true
        return receipt
      },
      {
        commitGuard() {
          assert()
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
    })
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
