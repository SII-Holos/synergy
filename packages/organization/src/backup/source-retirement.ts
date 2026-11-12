import { createHash } from "node:crypto"
import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { HomeOwnershipFile } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership-file"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { ServerProcessLock } from "@ericsanchezok/synergy-harness/util/server-process-lock"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationCurrentAuthorityInfo } from "./current-authority-schema"
import { OrganizationInstallationReference } from "./installation-reference"
import { OrganizationServiceHome } from "../service-home"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const SourceOwner = z.discriminatedUnion("schemaVersion", [
  HomeOwnershipFile.FencedInfo,
  HomeOwnershipFile.RestorationInfo,
])
const RetirementReference = z.strictObject({
  version: z.literal(1),
  current: OrganizationCurrentAuthorityInfo.refine(
    (value) => value.maintenance.purpose === "organization-backup" && value.maintenance.phase === "frozen",
    "Source retirement requires its verified frozen source",
  ),
  target: OrganizationInstallationReference,
  owner: SourceOwner,
  physicalHash: OrganizationProtocol.Digest,
  primaryConfigHash: OrganizationProtocol.Digest,
})
function fail(message: string): never {
  throw new Error("Organization source retirement " + message)
}

export namespace OrganizationSourceRetirement {
  export const Reference = RetirementReference
  export type Reference = z.infer<typeof Reference>
  export function marker(reference: Reference) {
    const selected = Reference.parse(structuredClone(reference))
    return HomeOwnershipFile.RetirementInfo.parse({
      ...selected.owner,
      schemaVersion: 4,
      maintenanceID: selected.current.maintenance.maintenanceID,
      referenceHash: hash(selected),
      physicalHash: selected.physicalHash,
      source: selected.owner,
    })
  }
  export interface Receipt {
    readonly kind: "organization-source-retired"
  }
  const receipts = new WeakMap<Receipt, { reference: Reference; assert(): void; verify(): Promise<void> }>()
  const state = RuntimeContext.state(() => ({ pending: new Set<Promise<unknown>>() }))

  function binding(reference: Reference) {
    const runtime = RuntimeContext.current()
    const primary = Storage.current()
    const store = primary.store
    const objects = primary.artifactObjects
    const ports = objects && { blobs: objects.blobs, writerID: objects.writerID, now: objects.now }
    const artifactDirectory = primary.artifactDirectory
    if (hash(store.options) !== reference.primaryConfigHash) fail("requires its original primary Store configuration")
    const assert = () => {
      if (
        runtime !== RuntimeContext.current() ||
        runtime.storage !== primary ||
        Storage.current() !== primary ||
        primary.store !== store ||
        hash(store.options) !== reference.primaryConfigHash ||
        primary.artifactDirectory !== artifactDirectory ||
        primary.artifactObjects !== objects ||
        objects?.blobs !== ports?.blobs ||
        objects?.writerID !== ports?.writerID ||
        objects?.now !== ports?.now
      )
        fail("requires its original native Runtime and primary Store")
    }
    assert()
    return { runtime, assert }
  }
  async function verifyReservation(reference: Reference) {
    const retained = await RuntimeMaintenance.retirement(reference.current.maintenance.maintenanceID)
    const current = await RuntimeMaintenance.status()
    if (
      !retained ||
      retained.referenceHash !== hash(reference) ||
      hash(retained.source) !== hash(reference.current.maintenance) ||
      hash(current) !== hash(retained.source)
    )
      fail("requires its original permanent reference and frozen reservation")
  }
  export async function reference(
    current: z.infer<typeof OrganizationCurrentAuthorityInfo>,
    target: z.infer<typeof OrganizationInstallationReference>,
  ) {
    const source = OrganizationCurrentAuthorityInfo.parse(structuredClone(current))
    const selected = OrganizationInstallationReference.parse(structuredClone(target))
    const native = await OrganizationServiceHome.retirementOwner()
    const writer = await ServerProcessLock.currentOwnership()
    await ServerProcessLock.verifyOwnership(writer)
    const reference = Reference.parse({
      version: 1,
      current: source,
      target: selected,
      owner: native.ownership.schemaVersion === 4 ? native.ownership.source : native.ownership,
      physicalHash: await native.files.physicalHash(),
      primaryConfigHash: hash(Storage.current().store.options),
    })
    if (native.ownership.schemaVersion === 4 && native.ownership.referenceHash !== hash(reference))
      fail("requires its original permanent reference")
    return reference
  }
  export function describe(receipt: Receipt) {
    const original = receipts.get(receipt)
    if (!original) fail("requires original verified source evidence")
    original.assert()
    return Reference.parse(original.reference)
  }
  export async function verify(receipt: Receipt) {
    const original = receipts.get(receipt)
    if (!original) fail("requires original verified source evidence")
    original.assert()
    await original.verify()
    original.assert()
  }
  function track<T>(work: Promise<T>) {
    const pending = state().pending
    pending.add(work)
    work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    )
    return work
  }
  export function complete(value: Reference) {
    const reference = Reference.parse(structuredClone(value))
    const original = binding(reference)
    return track(
      (async () => {
        const writer = await ServerProcessLock.currentOwnership()
        const assert = () => {
          original.assert()
          ServerProcessLock.assertCurrent(writer)
        }
        const verify = async () => {
          assert()
          await ServerProcessLock.verifyOwnership(writer)
          assert()
          await verifyReservation(reference)
          assert()
        }
        await verify()
        const native = await OrganizationServiceHome.inspectRetirement(marker(reference))
        assert()
        const files = native.files
        if ((await files.physicalHash()) !== reference.physicalHash) fail("requires its original physical source Home")
        await verify()
        await files.retire(reference.owner)
        await verify()
        await files.assert({ required: true })
        assert()
        const receipt: Receipt = Object.freeze({ kind: "organization-source-retired" })
        receipts.set(receipt, {
          reference,
          assert,
          async verify() {
            await verify()
            await files.assert({ required: true })
            assert()
          },
        })
        return receipt
      })(),
    )
  }
  export async function assertReserved(value: Reference) {
    const reference = Reference.parse(structuredClone(value))
    const original = binding(reference)
    await verifyReservation(reference)
    original.assert()
    const native = await OrganizationServiceHome.inspectRetirement(marker(reference))
    if ((await native.files.physicalHash()) !== reference.physicalHash)
      fail("requires its original physical source Home")
    original.assert()
  }
  export async function drain() {
    const results = await Promise.allSettled([...state().pending])
    const errors = results.filter((value) => value.status === "rejected").map((value) => value.reason)
    if (errors.length) throw new AggregateError(errors, "Accepted source retirement did not complete")
  }
}
