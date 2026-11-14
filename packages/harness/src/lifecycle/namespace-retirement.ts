import { createHash } from "node:crypto"
import path from "node:path"
import { z } from "zod"
import { RuntimeContext } from "./context"
import { HomeOwnershipFile } from "./home-ownership-file"
import { NativeNamespaceIdentity } from "./namespace-identity"
import { RestorationRequest } from "./home-restoration-file"
import { RuntimeMaintenance } from "../storage/runtime-maintenance"
import { Storage } from "../storage/storage"
import { StorageCheckpoint } from "../storage/checkpoint"
import { SnapshotMaintenance } from "../session/snapshot-maintenance"
import { ServerProcessLock } from "../util/server-process-lock"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const Owner = z.discriminatedUnion("schemaVersion", [HomeOwnershipFile.FencedInfo, HomeOwnershipFile.RestorationInfo])
const RetirementReference = z.strictObject({
  version: z.literal(1),
  target: z.strictObject({ request: RestorationRequest, installationID: z.uuid(), incarnation: z.uuid() }),
  namespace: NativeNamespaceIdentity.Descriptor,
  archive: StorageCheckpoint.Manifest,
  nativeHash: Hash,
  owner: Owner,
  maintenance: RuntimeMaintenance.Info.refine(
    (value) => value.phase === "frozen" && value.purpose === "organization-backup",
  ),
  physicalHash: Hash,
  configurationHash: Hash,
})
function fail(message: string): never {
  throw new RuntimeMaintenance.Blocked({ message: "Native namespace retirement " + message })
}
function configuration() {
  const selected = Storage.current().store.options
  if (selected.backend !== "sqlite" || Storage.current().artifactObjects)
    fail("requires its owning external storage reconstruction adapter")
  return hash({ backend: selected.backend, filename: path.resolve(selected.filename), namespace: selected.namespace })
}
function binding(reference: z.infer<typeof RetirementReference>) {
  const runtime = RuntimeContext.current()
  const primary = runtime.storage
  if (!primary || primary !== Storage.current()) fail("requires its original primary Store")
  const store = primary.store
  const options = hash(store.options)
  const artifacts = primary.artifactDirectory
  if (configuration() !== reference.configurationHash) fail("requires its original dataset configuration")
  const assertLive = () => {
    if (
      runtime.storage !== primary ||
      primary.store !== store ||
      hash(store.options) !== options ||
      primary.artifactDirectory !== artifacts ||
      primary.artifactObjects
    )
      fail("requires its original Runtime, Store and artifact directory")
  }
  const assert = () => {
    assertLive()
    if (RuntimeContext.current() !== runtime || Storage.current() !== primary)
      fail("belongs to another native Runtime or Store")
  }
  assert()
  return { runtime, assert, assertLive }
}

export namespace NamespaceRetirement {
  export const Reference = RetirementReference
  export type Reference = z.infer<typeof Reference>
  export interface Source {
    readonly kind: "native-namespace-retirement-source"
  }
  export interface Receipt {
    readonly kind: "native-namespace-retired"
  }
  export interface Inspection {
    readonly kind: "native-namespace-retirement-inspection"
  }
  const sources = new WeakMap<
    Source,
    {
      reference: Reference
      lease: RuntimeMaintenance.Lease
      assert(): void
      verify(): Promise<void>
      accept(work: Promise<Receipt>): void
    }
  >()
  const receipts = new WeakMap<
    Receipt,
    { reference: Reference; assert(): void; assertLive(): void; verify(): Promise<void> }
  >()
  const inspections = new WeakMap<Inspection, { reference: Reference; assert(): void }>()
  const failed = new WeakSet<Promise<Receipt>>()
  interface NativeSource {
    owner: string
    inspect(native: object, archive: SnapshotMaintenance.ArchiveEvidence): string
  }
  const state = RuntimeContext.state(() => ({
    source: undefined as NativeSource | undefined,
    accepting: true,
    effects: new Map<string, Promise<Receipt>>(),
    accepted: new Set<string>(),
    reads: new Set<Promise<unknown>>(),
  }))
  export function registerSource(source: NativeSource) {
    RuntimeContext.assertCompositionOpen("native namespace retirement")
    if (state().source) fail("native source is already registered")
    state().source = Object.freeze({
      owner: NativeNamespaceIdentity.Descriptor.shape.owner.parse(source.owner),
      inspect: source.inspect.bind(source),
    })
  }
  export async function withSource<T>(
    input: {
      archive: SnapshotMaintenance.ArchiveEvidence
      lease: RuntimeMaintenance.Lease
      native: object
      target: Reference["target"]
    },
    body: (source: Source) => Promise<T>,
  ) {
    if (!state().accepting) fail("native owner is closing")
    const archive = input.archive
    const lease = input.lease
    const nativeOwner = state().source
    if (!nativeOwner) fail("requires its installed owning native source")
    const nativeHash = Hash.parse(nativeOwner.inspect(input.native, archive))
    const target = Reference.shape.target.parse(structuredClone(input.target))
    const namespace = await NativeNamespaceIdentity.capture()
    const descriptor = NativeNamespaceIdentity.inspect(namespace)
    const manifest = SnapshotMaintenance.assertArchive(archive).namespace
    const runtime = RuntimeContext.current()
    const files = HomeOwnershipFile.open({ root: runtime.host.root, env: runtime.host.env })
    const owner = Owner.parse(await files.read())
    if (owner.owner !== descriptor.owner || owner.owner !== nativeOwner.owner)
      fail("has another installed native owner")
    const maintenance = await RuntimeMaintenance.assertHeld(lease)
    const reference = Reference.parse({
      version: 1,
      target,
      namespace: descriptor,
      archive: manifest,
      nativeHash,
      owner,
      maintenance,
      physicalHash: await files.physicalHash(),
      configurationHash: configuration(),
    })
    const selected = binding(reference)
    let open = true
    let accepting = true
    const accepted = new Map<string, Promise<Receipt>>()
    const assert = () => {
      if (!open) fail("source callback has ended")
      selected.assert()
      SnapshotMaintenance.assertArchive(archive)
    }
    const verify = async () => {
      assert()
      if (hash(await RuntimeMaintenance.assertHeld(lease)) !== hash(reference.maintenance))
        fail("maintenance changed before permanent retirement")
      await NativeNamespaceIdentity.verify(namespace)
      assert()
      if (
        hash(Owner.parse(await files.read())) !== hash(owner) ||
        (await files.physicalHash()) !== reference.physicalHash
      )
        fail("installed native Home changed")
    }
    const source: Source = Object.freeze({ kind: "native-namespace-retirement-source" })
    sources.set(source, {
      reference,
      lease,
      assert() {
        assert()
        if (!accepting) fail("source no longer accepts new retirement")
      },
      verify,
      accept(work) {
        accepted.set(hash(reference), work)
      },
    })
    const outcome = await Promise.resolve()
      .then(async () => {
        await verify()
        return body(source)
      })
      .then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      )
    accepting = false
    const outcomes = await Promise.allSettled(accepted.values())
    open = false
    const errors = outcomes.flatMap((value) => (value.status === "rejected" ? [value.reason] : []))
    if (outcome.status === "rejected" && !errors.includes(outcome.reason)) errors.unshift(outcome.reason)
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, "Accepted namespace retirement did not complete")
    if (outcome.status === "rejected") throw outcome.reason
    return outcome.value
  }
  export function describeSource(source: Source) {
    const selected = sources.get(source)
    if (!selected) fail("requires its actual captured native source")
    selected.assert()
    return Reference.parse(selected.reference)
  }
  export function retire(source: Source) {
    const selected = sources.get(source)
    if (!selected) fail("requires its actual captured native source")
    selected.assert()
    const work = effect(selected.reference, async (accept) => {
      const retained = await RuntimeMaintenance.retirement(selected.reference.maintenance.maintenanceID)
      if (!retained) {
        await selected.verify()
        await RuntimeMaintenance.reserveRetirement(selected.lease, hash(selected.reference))
      } else if (retained.referenceHash !== hash(selected.reference)) fail("has another original permanent reference")
      accept()
      return completeNative(selected.reference)
    })
    selected.accept(work)
    void work.catch(() => {})
    return work
  }
  export function marker(value: Reference) {
    const reference = Reference.parse(value)
    return HomeOwnershipFile.RetirementInfo.parse({
      ...reference.owner,
      schemaVersion: 4,
      maintenanceID: reference.maintenance.maintenanceID,
      referenceHash: hash(reference),
      physicalHash: reference.physicalHash,
      source: reference.owner,
    })
  }
  function effect(reference: Reference, body: (accept: () => void) => Promise<Receipt>) {
    if (!state().accepting) fail("native owner is closing")
    const id = hash(reference)
    const existing = state().effects.get(id)
    if (existing && !failed.has(existing)) return existing
    const work = Promise.resolve().then(() => body(() => state().accepted.add(id)))
    state().effects.set(id, work)
    void work.catch(() => failed.add(work))
    return work
  }
  export function complete(value: Reference): Promise<Receipt> {
    const reference = Reference.parse(structuredClone(value))
    binding(reference).assert()
    if (Storage.current().store.options.readonly) fail("permanent completion requires its writable primary Store")
    return effect(reference, (accept) => completeNative(reference, false, accept))
  }
  async function completeNative(value: Reference, readOnly = false, accept?: () => void): Promise<Receipt> {
    const reference = Reference.parse(structuredClone(value))
    const selected = binding(reference)
    const writer = await ServerProcessLock.currentOwnership()
    const assert = () => {
      selected.assert()
      ServerProcessLock.assertCurrent(writer)
    }
    const verify = async () => {
      assert()
      await ServerProcessLock.verifyOwnership(writer)
      const permanent = await RuntimeMaintenance.retirement(reference.maintenance.maintenanceID)
      const current = await RuntimeMaintenance.operation(reference.maintenance.maintenanceID)
      if (
        !permanent ||
        permanent.referenceHash !== hash(reference) ||
        hash(permanent.source) !== hash(reference.maintenance) ||
        hash(current) !== hash(reference.maintenance)
      )
        fail("requires its original immutable retirement reservation")
      assert()
    }
    await verify()
    const files = HomeOwnershipFile.open({
      root: selected.runtime.host.root,
      env: selected.runtime.host.env,
      selected: marker(reference),
    })
    if ((await files.physicalHash()) !== reference.physicalHash) fail("belongs to another physical Home")
    const status = await files.inspectRetirement(reference.owner)
    await verify()
    if (readOnly) {
      if (status !== "retired") fail("read-only inspection requires its completed original physical fence")
    } else {
      accept?.()
      await files.retire(reference.owner)
    }
    await files.assert({ required: true })
    await verify()
    const receipt: Receipt = Object.freeze({ kind: "native-namespace-retired" })
    receipts.set(receipt, {
      reference,
      assert,
      assertLive() {
        selected.assertLive()
        ServerProcessLock.assertLive(writer)
      },
      async verify() {
        await verify()
        await files.assert({ required: true })
        assert()
      },
    })
    return receipt
  }
  export function read(value: Reference): Promise<Receipt> {
    if (!state().accepting) fail("native owner is closing")
    const reference = Reference.parse(structuredClone(value))
    binding(reference).assert()
    const work = completeNative(reference, true)
    const reads = state().reads
    reads.add(work)
    void work.then(
      () => reads.delete(work),
      () => reads.delete(work),
    )
    return work
  }
  export function describe(receipt: Receipt) {
    const selected = receipts.get(receipt)
    if (!selected) fail("requires its actual physical retirement receipt")
    selected.assert()
    return Reference.parse(selected.reference)
  }
  export function withVerified<T>(receipt: Receipt, body: (inspection: Inspection) => Promise<T>): Promise<T> {
    if (!state().accepting) fail("native owner is closing")
    const work = verifyNative(receipt, body)
    const selected = state().reads
    selected.add(work)
    void work.then(
      () => selected.delete(work),
      () => selected.delete(work),
    )
    return work
  }
  async function verifyNative<T>(receipt: Receipt, body: (inspection: Inspection) => Promise<T>) {
    const selected = receipts.get(receipt)
    if (!selected) fail("requires its actual physical retirement receipt")
    selected.assert()
    await selected.verify()
    const owner = binding(selected.reference)
    let open = true
    const inspection: Inspection = Object.freeze({ kind: "native-namespace-retirement-inspection" })
    inspections.set(inspection, {
      reference: selected.reference,
      assert() {
        if (!open) fail("physical inspection callback has ended")
        owner.assertLive()
        selected.assertLive()
      },
    })
    try {
      const result = await body(inspection)
      await selected.verify()
      return result
    } finally {
      open = false
    }
  }
  export function inspect(inspection: Inspection) {
    const selected = inspections.get(inspection)
    if (!selected) fail("requires its actual physical inspection")
    selected.assert()
    return Reference.parse(selected.reference)
  }
  export async function stop() {
    state().accepting = false
    const effects = [...state().effects.entries()]
    await Promise.allSettled(state().reads)
    const outcomes = await Promise.all(
      effects.map(async ([id, work]) => {
        try {
          await work
          return { id, status: "fulfilled" as const }
        } catch (reason) {
          return { id, status: "rejected" as const, reason }
        }
      }),
    )
    const errors = outcomes.flatMap((value) =>
      value.status === "rejected" && state().accepted.has(value.id) ? [value.reason] : [],
    )
    if (errors.length) throw new AggregateError(errors, "Accepted native namespace retirement did not complete")
  }
}
