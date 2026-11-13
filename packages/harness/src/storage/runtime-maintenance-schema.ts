import { z } from "zod"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import { HomeOwnershipFile } from "../lifecycle/home-ownership-file"
import { NativeNamespaceIdentity } from "../lifecycle/namespace-identity"

export namespace RuntimeMaintenanceSchema {
  const ID = z.string().min(1).max(128)
  const Count = z.number().int().nonnegative().safe()
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  export const Operator = ActorStamp.Info.refine(
    (actor) => actor.kind !== "account",
    "Maintenance requires trusted Host authority",
  )
  const legacyPurpose = z.enum(["organization-backup", "organization-restore"])
  export const Purpose = z.enum([...legacyPurpose.options, "organization-home-upgrade"])
  const selection = z.strictObject({
    version: z.literal(1),
    source: HomeOwnershipFile.FencedInfo,
    target: HomeOwnershipFile.FencedInfo,
    namespace: NativeNamespaceIdentity.Descriptor,
    signingHash: Hash,
  })
  const sameOwner = (value: z.infer<typeof selection>) =>
    value.namespace.owner === value.source.owner &&
    JSON.stringify({ ...value.source, readerContract: value.target.readerContract }) === JSON.stringify(value.target)
  export const HomeUpgradeSelection = selection.refine(sameOwner, "Home upgrade must retain its original native owner")
  export const HomeUpgradeNative = selection
    .extend({
      ownerID: ID,
      ownerVersion: Count.positive(),
      physicalHash: Hash,
      primaryConfigHash: Hash,
      artifactDirectory: z.string().min(1),
    })
    .refine(sameOwner, "Home upgrade must retain its original native owner")
  export const SourcePreparationSelection = z
    .strictObject({
      version: z.literal(1),
      source: HomeOwnershipFile.FencedInfo,
      namespace: NativeNamespaceIdentity.Descriptor,
      signingHash: Hash,
      selectionHash: Hash,
    })
    .refine(
      (value) => value.source.owner === value.namespace.owner,
      "Source preparation requires its original namespace owner",
    )
  export const SourcePreparationNative = SourcePreparationSelection.safeExtend({
    ownerID: ID,
    ownerVersion: Count.positive(),
    physicalHash: Hash,
    primaryConfigHash: Hash,
    artifactDirectory: z.string().min(1),
  })
  const fields = {
    maintenanceID: ID,
    requestID: ID,
    requestHash: Hash,
    purpose: Purpose,
    sourceRuntimeID: ID,
    cohortHash: Hash,
    phase: z.enum(["draining", "frozen", "releasing", "released", "recovery-held"]),
    revision: Count.positive(),
    tailRevision: Count,
    actor: Operator,
    createdAt: Count,
    updatedAt: Count,
  }
  const legacy = z.strictObject({ version: z.literal(1), ...fields, purpose: legacyPurpose })
  export const HomeUpgradeInfo = z.strictObject({
    version: z.literal(2),
    ...fields,
    purpose: z.literal("organization-home-upgrade"),
    phase: z.enum(["draining", "frozen", "releasing", "released"]),
    native: HomeUpgradeNative,
  })
  export const SourcePreparationInfo = z.strictObject({
    version: z.literal(3),
    ...fields,
    purpose: z.literal("organization-backup"),
    phase: z.enum(["draining", "frozen", "releasing", "released"]),
    native: SourcePreparationNative,
  })
  export const Info = z.discriminatedUnion("version", [legacy, HomeUpgradeInfo, SourcePreparationInfo])
}
