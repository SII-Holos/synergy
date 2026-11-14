import path from "node:path"
import { createHash } from "node:crypto"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeRestoration } from "@ericsanchezok/synergy-harness/lifecycle/home-restoration"
import { NamespaceRetirement } from "@ericsanchezok/synergy-harness/lifecycle/namespace-retirement"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StorageMutationGuard } from "@ericsanchezok/synergy-harness/storage/mutation-guard"
import type { StoreTransaction } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { SessionLifecycle } from "@ericsanchezok/synergy-harness/session/lifecycle"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { FileAtomicWrite } from "@ericsanchezok/synergy-local-runtime/file/atomic-write"
import {
  OrganizationRuntimeProtocol as Protocol,
  OrganizationProtocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { HostedBinding } from "../home-schema"
import { runtimeIdentityDigest } from "../home"
import { MemberHomeError, readRecordSnapshot } from "../record"
import { captureCredentialRecord } from "../credentials"
import { CortexTypes } from "@ericsanchezok/synergy-harness/cortex/types"
import { captureRegistrationRecord, registrationRecord } from "../registration"
import { connectionState, connectionRecord } from "../connection-state"

const Hash = OrganizationProtocol.Digest
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const sourceHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const key = (id: string) => ["organization-runtime-recovery", "publication", id]
const Target = z.strictObject({
  installationID: z.uuid(),
  incarnation: z.uuid(),
  restoreID: HomeRestoration.Request.shape.restoreID,
  requestHash: Hash,
  sourceHash: Hash,
  nativeHash: Hash,
})
const Facts = z.strictObject({
  kind: z.literal("organization-hosted-recovery"),
  target: Target,
  sourceReferenceHash: Hash,
  registration: Protocol.HostedRegistrationRecord,
})
const Receipt = z.strictObject({
  version: z.literal(1),
  target: HomeRestoration.Info,
  request: HomeRestoration.Request,
  source: NamespaceRetirement.Reference,
  service: z.strictObject({
    installation: HomeRestoration.Info,
    publicationHash: Hash,
    subject: z.string(),
    facts: Facts,
  }),
  registration: Protocol.HostedRegistrationRecord,
  binding: HostedBinding,
  credentialHash: Hash,
  connectionEpoch: z.number().int().nonnegative().safe(),
})
const writes = RuntimeContext.createAsyncContext<{ tx: StoreTransaction; key: string[]; assert(): void }>()
function fail(message: string): never {
  throw new Error("Hosted publication " + message)
}
function sameInstallation(left: HomeRestoration.Info, right: HomeRestoration.Info) {
  return (
    left.installationID === right.installationID &&
    left.incarnation === right.incarnation &&
    left.owner === right.owner &&
    left.requestHash === right.requestHash &&
    left.sourceHash === right.sourceHash &&
    left.restoreID === right.restoreID
  )
}

const pending = RuntimeContext.state(() => ({ accepting: true, work: new Map<string, Promise<void>>() }))
const failed = new WeakSet<Promise<void>>()

export namespace OrganizationHostedPublication {
  export type Receipt = z.infer<typeof Receipt>
  export function registration(proof: HomeRestoration.PublicationInspection, source: NamespaceRetirement.Reference) {
    const inspected = HomeRestoration.inspectPublication(proof)
    const facts = Facts.parse(inspected.facts)
    const service = inspected.installation
    const original = source.target
    if (
      service.owner !== "organization" ||
      service.installationID !== original.installationID ||
      service.incarnation !== original.incarnation ||
      service.requestHash !== hash(original.request) ||
      service.restoreID !== original.request.restoreID ||
      service.sourceHash !== original.request.sourceHash ||
      !inspected.status.nativeReady ||
      !inspected.status.released ||
      facts.target.installationID !== service.installationID ||
      facts.target.incarnation !== service.incarnation ||
      facts.target.requestHash !== service.requestHash ||
      facts.target.sourceHash !== service.sourceHash ||
      facts.target.restoreID !== service.restoreID ||
      facts.sourceReferenceHash !== hash(source)
    )
      fail("requires its original ready service and retired writer mapping")
    const current = facts.registration
    const previous = source.namespace.identity
    if (
      inspected.subject !== current.runtimeID ||
      previous.kind !== "hosted" ||
      current.runtimeID !== previous.runtimeID ||
      current.publicKey !== previous.publicKey ||
      current.orgID !== previous.orgID ||
      current.deploymentIncarnation !== service.incarnation
    )
      fail("registry differs from its original Hosted writer")
    return {
      installation: inspected.installation,
      publicationHash: inspected.publicationHash,
      subject: inspected.subject,
      facts,
    }
  }
  export async function write(
    tx: StoreTransaction,
    input: {
      permit: HomeRestoration.InstallPermit
      request: HomeRestoration.Request
      source: NamespaceRetirement.Reference
      service: HomeRestoration.PublicationInspection
      binding: z.infer<typeof HostedBinding>
      credentialHash: string
      connectionEpoch: number
    },
  ) {
    const permit = input.permit
    const request = HomeRestoration.Request.parse(structuredClone(input.request))
    const source = NamespaceRetirement.Reference.parse(structuredClone(input.source))
    const service = input.service
    const binding = HostedBinding.parse(structuredClone(input.binding))
    if (
      binding.state !== "ready" ||
      runtimeIdentityDigest(binding.identity) !== source.owner.identity ||
      binding.publicKey !== source.namespace.identity.publicKey
    )
      fail("binding differs from its original native identity")
    const credentialHash = Hash.parse(input.credentialHash)
    const connectionEpoch = input.connectionEpoch
    const target = HomeRestoration.describe(permit)
    const assert = () => {
      HomeRestoration.assertRequest(permit, request)
      HomeRestoration.assertInstalledOwner(permit)
      registration(service, source)
    }
    assert()
    Storage.current().store.assertWriteTransaction(tx)
    if (Storage.current().transaction !== tx) fail("requires its actual restored target transaction")
    const mapping = registration(service, source)
    const receipt = Receipt.parse({
      version: 1,
      target,
      request,
      source,
      service: mapping,
      registration: mapping.facts.registration,
      binding,
      credentialHash,
      connectionEpoch: Math.max(connectionEpoch, mapping.facts.registration.connectionEpoch),
    })
    const address = key(target.installationID)
    let complete = false
    return Storage.transaction(
      async () => {
        const existing = (await tx.readMany([address]))[0]
        if (existing !== undefined) {
          if (hash(Receipt.parse(existing)) !== hash(receipt)) fail("cannot replace its original immutable publication")
          complete = true
          return Receipt.parse(existing)
        }
        for await (const row of Storage.records({ kind: "session", limit: 128 })) {
          const recorded = Session.PersistedInfo.parse({
            ...z.record(z.string(), z.unknown()).parse(row.value),
            workspace: null,
          })
          const session = await Session.get(recorded.id)
          if (session.scope.id !== recorded.scope.id || session.id !== recorded.id)
            fail("Session identity changed during restoration")
          if (session.cortex && !CortexTypes.isTerminalStatus(session.cortex.status))
            fail("requires its canonical Cortex restoration owner")
          if (session.time.archived) continue
          if (!SessionLifecycle.latchable(session)) fail("requires its canonical unattended workflow restoration owner")
          await ScopeContext.provide({
            scope: session.scope,
            workspace: null,
            fn: () =>
              SessionLifecycle.pause({
                sessionID: session.id,
                reason: "interrupted",
                description: "Restored from a verified organization backup; explicit Continue is required",
              }),
          })
          assert()
        }
        await writes.run({ tx, key: address, assert }, () => Storage.write(address, receipt))
        complete = true
        return receipt
      },
      {
        commitGuard() {
          assert()
          if (!complete) fail("publication did not complete")
        },
      },
    )
  }
  async function read(info: HomeRestoration.Info) {
    const value = Receipt.parse(await Storage.read(key(info.installationID)))
    if (
      !sameInstallation(info, value.target) ||
      info.owner !== "organization-runtime" ||
      hash(value.request) !== info.requestHash ||
      hash(value.source.archive) !== info.sourceHash ||
      value.service.facts.sourceReferenceHash !== hash(value.source)
    )
      fail("receipt belongs to another original installation")
    return value
  }
  async function nativeReady(receipt: Receipt) {
    const root = RuntimeContext.current().host.root
    const binding = await readRecordSnapshot(path.join(root, "organization.json"), HostedBinding, "identity records")
    if (!binding || binding.value.state !== "ready" || hash(binding.value) !== hash(receipt.binding)) return false
    const member = {
      home: RuntimeContext.current().host.home,
      root,
      identity: binding.value.identity,
      origin: binding.value.origin,
      publicKey: binding.value.publicKey,
    }
    const enrollment = await captureRegistrationRecord(member)
    const credential = await captureCredentialRecord(root)
    if (
      !enrollment ||
      hash(enrollment.value.registration) !== hash(receipt.registration) ||
      sourceHash(credential.bytes) !== receipt.credentialHash
    )
      return false
    const connection = await connectionState(member, receipt.registration)
      .snapshot()
      .catch((error: unknown) => {
        if (error instanceof MemberHomeError) return undefined
        throw error
      })
    return !!connection?.record && connection.epoch >= receipt.connectionEpoch
  }

  export function register() {
    StorageMutationGuard.register("hosted-restoration-publication", async (tx, keys, tree) => {
      const prefix = ["organization-runtime-recovery", "publication"]
      for (const candidate of keys) {
        if (
          !prefix.every((part, index) => candidate[index] === part) &&
          !(tree && candidate.every((part, index) => prefix[index] === part))
        )
          continue
        const owner = writes.getStore()
        if (!owner || owner.tx !== tx || tree || hash(candidate) !== hash(owner.key))
          fail("requires its owning publication transaction")
        owner.assert()
      }
    })
    HomeRestoration.registerPublicationOwner("organization-runtime", {
      async read(info) {
        const receipt = await read(info)
        const restored = await RuntimeMaintenance.restoration(info.installationID)
        const operation = await RuntimeMaintenance.operation(info.installationID)
        if (
          !restored ||
          !operation ||
          hash(restored.source) !== hash(receipt.source.maintenance) ||
          restored.requestHash !== info.requestHash ||
          restored.incarnation !== info.incarnation ||
          !["recovery-held", "released"].includes(operation.phase)
        )
          fail("requires its original held or released maintenance installation")
        if (
          hash(operation) !==
          hash({
            ...restored.target,
            ...(operation.phase === "released"
              ? { phase: "released", revision: restored.target.revision + 1, updatedAt: operation.updatedAt }
              : {}),
          })
        )
          fail("maintenance publication differs from its original release")
        return {
          publicationHash: hash(receipt),
          nativeReady: await nativeReady(receipt),
          released: operation.phase === "released",
        }
      },
    })
  }
  export function complete(value: string): Promise<void> {
    const installationID = z.uuid().parse(value)
    if (!pending().accepting) fail("native publisher is closing")
    const current = pending().work.get(installationID)
    if (current && !failed.has(current)) return current
    const work = publishNative(installationID)
    pending().work.set(installationID, work)
    void work.catch(() => failed.add(work))
    return work
  }
  async function publishNative(installationID: string) {
    const selected = Receipt.parse(await Storage.read(key(installationID)))
    await HomeRestoration.withPublication({ installationID, publicationHash: hash(selected) }, async (permit) => {
      if ((await HomeRestoration.verifyPublication(permit)).released) return
      await FileAtomicWrite.withRoot(RuntimeContext.current().host.root, async (root) => {
        await HomeRestoration.verifyPublication(permit)
        HomeRestoration.assertPublication(permit)
        await FileAtomicWrite.write(
          root,
          ["organization-registration.json"],
          Buffer.from(JSON.stringify(registrationRecord(selected.registration))),
        )
        await FileAtomicWrite.write(
          root,
          ["organization-connection.json"],
          Buffer.from(JSON.stringify(connectionRecord(selected.registration, selected.connectionEpoch))),
        )
        HomeRestoration.assertPublication(permit)
      })
      await HomeRestoration.completePublication(permit)
      await RuntimeMaintenance.releaseRestoration(permit)
    })
  }
  export async function drain() {
    pending().accepting = false
    const outcomes = await Promise.allSettled(pending().work.values())
    const errors = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : []))
    if (errors.length) throw new AggregateError(errors, "Accepted Hosted native publication did not complete")
  }
}
