import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol } from "./core.js"
import { SigningSignature, digestProtocol, signedProtocol } from "./signature.js"

export namespace OrganizationHandoffProtocol {
  export const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  export const Requirement = z.strictObject({
    code: Identity.ID,
    label: z.string().min(1).max(1024),
    recoverable: z.boolean(),
  })
  export const Phase = z.enum([
    "preparing",
    "prepared",
    "surrendered",
    "committed",
    "activation_permitted",
    "completed",
    "cancelled",
    "retired",
  ])
  const Binding = z.strictObject({
    schemaVersion: z.literal(1),
    orgID: Identity.ID,
    deploymentIncarnation: Identity.ID,
    handoffID: Identity.ID,
    sessionID: Identity.ID,
    sourceRuntimeID: Identity.ID,
    targetRuntimeID: Identity.ID,
    fromEpoch: OrganizationProtocol.Epoch,
    toEpoch: OrganizationProtocol.Epoch,
    mappingPlanRevision: z.number().int().positive().safe(),
    shareGeneration: Identity.Revision,
  })
  export const Proof = z
    .discriminatedUnion("purpose", [
      Binding.extend({
        purpose: z.literal("source-frozen"),
        manifestHash: Hash,
        commandSeq: Identity.Revision,
        receivedSeq: Identity.Revision,
        compatibilityHash: Hash,
        closureHash: Hash,
        workspaceMoveReceiptHash: Hash.nullable(),
        paused: z.literal(true),
        drained: z.literal(true),
      }),
      Binding.extend({
        purpose: z.literal("target-prepared"),
        manifestHash: Hash,
        compatibilityHash: Hash,
        convertedHash: Hash,
        closureHash: Hash,
        workspaceMoveReceiptHash: Hash.nullable(),
        paused: z.literal(true),
      }),
      Binding.extend({
        purpose: z.literal("source-surrendered"),
        manifestHash: Hash,
        permitID: Identity.ID,
        preparedHash: Hash,
        gatePersisted: z.literal(true),
      }),
      Binding.extend({
        purpose: z.literal("source-cancelled"),
        manifestHash: Hash.nullable(),
        gateCancelled: z.literal(true),
        paused: z.literal(true),
      }),
      Binding.extend({
        purpose: z.literal("target-activated"),
        manifestHash: Hash,
        permitID: Identity.ID,
        preparedHash: Hash,
        paused: z.literal(true),
      }),
      Binding.extend({
        purpose: z.literal("target-never-activate"),
        manifestHash: Hash,
        preparedHash: Hash,
        tombstonePersisted: z.literal(true),
      }),
    ])
    .meta({ ref: "OrgHandoffProof" })
  export type Proof = z.infer<typeof Proof>
  export const SignedProof = z
    .strictObject({ proof: Proof, signature: SigningSignature })
    .meta({ ref: "OrgHandoffSignedProof" })
  export type SignedProof = z.infer<typeof SignedProof>
  const proofs = signedProtocol(Proof, "synergy.organization.handoff.fact.v1\n")
  export const signProof = proofs.sign
  export const verifyProof = proofs.verify
  export const proofHash = (proof: Proof) => digestProtocol(Proof, "synergy.organization.handoff.fact.v1\n", proof)
  export const Permit = Binding.extend({
    purpose: z.enum(["handoff-surrender", "handoff-activation"]),
    permitID: Identity.ID,
    keyID: Identity.ID,
    sourceBinding: OrganizationProtocol.SessionBinding.optional(),
    manifestHash: Hash,
    preparedHash: Hash,
    createdAt: z.number().int().nonnegative().safe(),
  }).meta({ ref: "OrgHandoffPermit" })
  export type Permit = z.infer<typeof Permit>
  export const SignedPermit = z
    .strictObject({ permit: Permit, signature: SigningSignature })
    .meta({ ref: "OrgHandoffSignedPermit" })
  export type SignedPermit = z.infer<typeof SignedPermit>
  const permits = signedProtocol(Permit, "synergy.organization.handoff.permit.v1\n")
  export const signPermit = permits.sign
  export const verifyPermit = permits.verify
  export const PermitRequest = z
    .strictObject({ purpose: z.enum(["handoff-surrender", "handoff-activation"]) })
    .meta({ ref: "OrgHandoffPermitRequest" })
  export type PermitRequest = z.infer<typeof PermitRequest>
  export const Prepare = z
    .strictObject({
      handoffID: Identity.ID,
      targetRuntimeID: Identity.ID,
      expectedBindingEpoch: OrganizationProtocol.Epoch,
      expectedControlRevision: Identity.Revision,
      mappingPlanRevision: z.number().int().positive().safe(),
    })
    .meta({ ref: "OrgHandoffPrepare" })
  export type Prepare = z.infer<typeof Prepare>
  export const Accept = z
    .strictObject({ mappingPlanRevision: z.number().int().positive().safe() })
    .meta({ ref: "OrgHandoffAccept" })
  export type Accept = z.infer<typeof Accept>
  export const View = Binding.extend({
    phase: Phase,
    initiator: Identity.ID,
    targetAccepted: z.boolean(),
    commandSeq: Identity.Revision,
    manifestHash: Hash.optional(),
    missingRequirements: z.array(Requirement),
    canCancel: z.boolean(),
    canAccept: z.boolean(),
    canContinue: z.boolean(),
    currentDriver: Identity.ID,
    bindingEpoch: OrganizationProtocol.Epoch,
  }).meta({ ref: "OrgHandoffView" })
  export type View = z.infer<typeof View>
  export const Page = z
    .strictObject({ items: z.array(View), cursor: Identity.ID.optional() })
    .meta({ ref: "OrgHandoffPage" })
}
