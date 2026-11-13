import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Organization } from "./core.js"
import { OrganizationCommandProtocol as Command } from "./command.js"
import { OrganizationRuntimeProtocol as Runtime } from "./runtime.js"
import { OrganizationHandoffProtocol as Handoff } from "./handoff.js"
import { digestProtocol, SigningSignature, signedProtocol } from "./signature.js"

export namespace OrganizationHandoffRecovery {
  const Window = {
    issuedAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().nonnegative().safe(),
  }
  const finite = (value: { issuedAt: number; expiresAt: number }) =>
    value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= 30_000
  const Target = z.strictObject({ binding: Handoff.Binding, manifestHash: Handoff.Hash })
  export const Proof = z
    .strictObject({
      schemaVersion: z.literal(1),
      purpose: z.literal("handoff-cleanup-recovery"),
      orgID: Identity.ID,
      deploymentIncarnation: Identity.ID,
      runtimeID: Identity.ID,
      requestID: Identity.ID,
      ...Window,
      query: z.discriminatedUnion("operation", [
        z.strictObject({ operation: z.literal("discover"), page: Identity.Page }),
        z.strictObject({ operation: z.literal("inspect-source-receipt"), handoffID: Identity.ID }),
        Target.extend({ operation: z.enum(["inspect-target", "retire-target"]) }),
      ]),
    })
    .refine(finite, "Cleanup recovery requests require a finite fresh window")
    .refine(
      (value) =>
        value.query.operation === "discover" ||
        value.query.operation === "inspect-source-receipt" ||
        (value.query.binding.orgID === value.orgID &&
          value.query.binding.deploymentIncarnation === value.deploymentIncarnation &&
          value.query.binding.targetRuntimeID === value.runtimeID),
      "Cleanup recovery cannot address another participant",
    )
    .meta({ ref: "OrgHandoffRecoveryProof" })
  export type Proof = z.infer<typeof Proof>
  export const Request = z
    .strictObject({ proof: Proof, signature: SigningSignature })
    .meta({ ref: "OrgHandoffRecoveryRequest" })
  export type Request = z.infer<typeof Request>
  const requests = signedProtocol(Proof, "synergy.organization.handoff.cleanup-request.v1\n")
  export const sign = requests.sign
  export const verify = requests.verify
  export const requestHash = (value: Proof) =>
    digestProtocol(Proof, "synergy.organization.handoff.cleanup-request.v1\n", value)
  export const Descriptor = Handoff.Binding.extend({
    manifestHash: Handoff.Hash,
    cleanupFactHash: Handoff.Hash.optional(),
  }).meta({ ref: "OrgHandoffCleanupDescriptor" })
  export const Page = z
    .strictObject({ items: z.array(Descriptor).max(100), cursor: Identity.ID.optional() })
    .meta({ ref: "OrgHandoffCleanupPage" })
  export type Page = z.infer<typeof Page>
  export const Permit = Handoff.Binding.extend({
    purpose: z.literal("handoff-target-cleanup"),
    requestID: Identity.ID,
    requestHash: Handoff.Hash,
    keyID: Identity.ID,
    runtimeID: Identity.ID,
    participantKey: Runtime.PublicKey,
    operation: z.enum(["inspect-target", "retire-target"]),
    sourceBinding: Organization.SessionBinding,
    controlRevision: Identity.Revision,
    manifestHash: Handoff.Hash,
    frozen: Handoff.SignedProof,
    cleanup: Handoff.SignedProof,
    sourceKey: Runtime.PublicKey,
    preparedHash: Handoff.Hash.optional(),
    workspacePlan: Handoff.MachinePlan.shape.workspacePlan.unwrap(),
    ...Window,
  })
    .refine(finite, "Cleanup permits require a finite window")
    .refine((value) => {
      const frozen = value.frozen.proof,
        cancelled = value.cleanup.proof
      return (
        value.runtimeID === value.targetRuntimeID &&
        value.sourceRuntimeID !== value.targetRuntimeID &&
        value.toEpoch > value.fromEpoch &&
        value.workspacePlan.mapping.kind === "organization-native" &&
        value.sourceBinding.orgID === value.orgID &&
        value.sourceBinding.driverRuntimeID === value.sourceRuntimeID &&
        value.sourceBinding.bindingEpoch === value.fromEpoch &&
        frozen.purpose === "source-frozen" &&
        !!frozen.workspaceSourceHash &&
        cancelled.purpose === "source-cancelled" &&
        frozen.manifestHash === value.manifestHash &&
        cancelled.manifestHash === value.manifestHash &&
        (Object.keys(Handoff.Binding.shape) as (keyof z.infer<typeof Handoff.Binding>)[]).every(
          (key) => frozen[key] === value[key] && cancelled[key] === value[key],
        )
      )
    }, "Cleanup permits retain only the exact cancelled native participant")
    .meta({ ref: "OrgHandoffRecoveryPermit" })
  export type Permit = z.infer<typeof Permit>
  export const SignedPermit = z
    .strictObject({ permit: Permit, signature: SigningSignature })
    .meta({ ref: "OrgHandoffSignedRecoveryPermit" })
  export type SignedPermit = z.infer<typeof SignedPermit>
  const permits = signedProtocol(Permit, "synergy.organization.handoff.target-cleanup.v1\n")
  export const signPermit = permits.sign
  export const verifyPermit = permits.verify
  export const SourceReceiptPermit = Handoff.Binding.extend({
    purpose: z.literal("handoff-source-receipt"),
    requestID: Identity.ID,
    requestHash: Handoff.Hash,
    keyID: Identity.ID,
    runtimeID: Identity.ID,
    participantKey: Runtime.PublicKey,
    operation: z.literal("inspect-source-receipt"),
    cancelRequested: z.boolean(),
    frozen: Handoff.SignedProof.optional(),
    cancelled: Handoff.SignedProof.optional(),
    surrendered: Handoff.SignedProof.optional(),
    surrenderPermit: Handoff.SignedPermit.optional(),
    ...Window,
  })
    .refine(finite, "Source receipt inspection requires a finite window")
    .refine((value) => {
      const same = (proof: z.infer<typeof Handoff.Binding>) =>
        (Object.keys(Handoff.Binding.shape) as (keyof z.infer<typeof Handoff.Binding>)[]).every(
          (field) => proof[field] === value[field],
        )
      const frozen = value.frozen?.proof,
        cancelled = value.cancelled?.proof,
        surrendered = value.surrendered?.proof,
        permit = value.surrenderPermit?.permit
      return (
        value.runtimeID === value.sourceRuntimeID &&
        value.sourceRuntimeID !== value.targetRuntimeID &&
        value.toEpoch > value.fromEpoch &&
        (!frozen || (frozen.purpose === "source-frozen" && same(frozen))) &&
        (!cancelled ||
          (cancelled.purpose === "source-cancelled" &&
            same(cancelled) &&
            (!frozen || cancelled.manifestHash === frozen.manifestHash))) &&
        (!permit ||
          (permit.purpose === "handoff-surrender" &&
            same(permit) &&
            (!frozen || permit.manifestHash === frozen.manifestHash))) &&
        (!surrendered ||
          (surrendered.purpose === "source-surrendered" &&
            same(surrendered) &&
            !!permit &&
            surrendered.permitID === permit.permitID &&
            surrendered.manifestHash === permit.manifestHash &&
            surrendered.preparedHash === permit.preparedHash)) &&
        !(cancelled && surrendered)
      )
    }, "Source receipt inspection retains only its original participant and facts")
    .meta({ ref: "OrgHandoffSourceReceiptPermit" })
  export type SourceReceiptPermit = z.infer<typeof SourceReceiptPermit>
  export const SignedSourceReceiptPermit = z
    .strictObject({ permit: SourceReceiptPermit, signature: SigningSignature })
    .meta({ ref: "OrgHandoffSignedSourceReceiptPermit" })
  export type SignedSourceReceiptPermit = z.infer<typeof SignedSourceReceiptPermit>
  const sourceReceipts = signedProtocol(SourceReceiptPermit, "synergy.organization.handoff.source-receipt.v1\n")
  export const signSourceReceipt = sourceReceipts.sign
  export const verifySourceReceipt = sourceReceipts.verify
  export const Response = z
    .strictObject({
      requestID: Identity.ID,
      requestHash: Handoff.Hash,
      signingIdentity: Command.SigningIdentity,
      result: z.discriminatedUnion("operation", [
        Page.extend({ operation: z.literal("discover") }).meta({ ref: "OrgHandoffCleanupDiscovery" }),
        z.strictObject({ operation: z.literal("inspect-source-receipt"), authorization: SignedSourceReceiptPermit }),
        z.strictObject({ operation: z.enum(["inspect-target", "retire-target"]), authorization: SignedPermit }),
      ]),
    })
    .meta({ ref: "OrgHandoffRecoveryResponse" })
  export type Response = z.infer<typeof Response>
}
