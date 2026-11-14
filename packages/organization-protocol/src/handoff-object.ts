import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol } from "./core.js"
import { OrganizationHandoffProtocol as Handoff } from "./handoff.js"
import { SigningSignature, signedProtocol } from "./signature.js"

export namespace OrganizationHandoffObjectProtocol {
  export const Proof = z
    .strictObject({
      schemaVersion: z.literal(1),
      purpose: z.literal("handoff-object-read"),
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
      runtimeID: Identity.ID,
      connectionEpoch: OrganizationProtocol.Epoch,
      requestID: Identity.ID,
      manifestHash: Handoff.Hash,
      range: Handoff.ObjectRange,
      issuedAt: z.number().int().nonnegative().safe(),
      expiresAt: z.number().int().nonnegative().safe(),
    })
    .refine(
      (value) =>
        value.runtimeID === value.targetRuntimeID &&
        value.sourceRuntimeID !== value.targetRuntimeID &&
        value.toEpoch > value.fromEpoch,
      "Handoff objects require the exact destination and source epoch tuple",
    )
    .refine(
      (value) => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= 30_000,
      "Handoff object reads require a finite machine authorization window",
    )
    .meta({ ref: "OrgHandoffObjectProof" })
  export type Proof = z.infer<typeof Proof>
  export const Request = z
    .strictObject({ proof: Proof, signature: SigningSignature })
    .meta({ ref: "OrgHandoffObjectRequest" })
  export type Request = z.infer<typeof Request>
  const signed = signedProtocol(Proof, "synergy.organization.handoff.object-read.v1\n")
  export const sign = signed.sign
  export const verify = signed.verify
}
