import { z } from "zod"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Protocol } from "./core.js"
import { SigningPublicKey, SigningSignature, signedProtocol } from "./signature.js"

export namespace OrganizationCommandProtocol {
  export const SigningIdentity = z
    .strictObject({
      schemaVersion: z.literal(1),
      orgID: Identity.ID,
      deploymentIncarnation: Identity.ID,
      keyID: Identity.ID,
      publicKey: SigningPublicKey,
    })
    .meta({ ref: "OrgServiceSigningIdentity" })
  export type SigningIdentity = z.infer<typeof SigningIdentity>
  export const Actor = ActorStamp.Account.extend({
    orgID: Identity.ID,
    subjectID: Identity.ID,
    requestID: Identity.ID,
    clientKind: z.enum(["web", "desktop", "cli", "api"]),
  })
  export const Operation = z.enum(["create", "input", "pause", "continue", "cancel"])
  export const Permit = z
    .strictObject({
      schemaVersion: z.literal(1),
      purpose: z.literal("session-command"),
      orgID: Identity.ID,
      deploymentIncarnation: Identity.ID,
      keyID: Identity.ID,
      requestID: Identity.ID,
      payloadHash: Protocol.Digest,
      sessionID: Identity.ID,
      projectID: Identity.ID,
      runtimeID: Identity.ID,
      bindingEpoch: Protocol.Epoch,
      connectionEpoch: Protocol.Epoch,
      commandSeq: Protocol.Epoch,
      shareGeneration: Identity.Revision,
      controlRevision: Identity.Revision,
      authRevision: Identity.Revision,
      admissionID: Identity.ID,
      attemptID: Identity.ID,
      actor: Actor,
      operation: Operation,
      authorizedAt: z.number().int().nonnegative(),
      deadline: z.number().int().nonnegative(),
      provisionalGrantID: Identity.ID.optional(),
    })
    .refine(
      (value) => value.actor.orgID === value.orgID && value.actor.requestID === value.requestID,
      "Actor must identify the same organization and logical request",
    )
    .refine(
      (value) => value.deadline > value.authorizedAt && value.deadline - value.authorizedAt <= 60_000,
      "Command permit lifetime must be positive and at most one minute",
    )
    .meta({ ref: "OrgCommandPermit" })
  export type Permit = z.infer<typeof Permit>
  export const SignedPermit = z
    .strictObject({ permit: Permit, signature: SigningSignature })
    .meta({ ref: "OrgSignedCommandPermit" })
  export type SignedPermit = z.infer<typeof SignedPermit>
  const signatures = signedProtocol(Permit, "synergy.organization.command.permit.v1\n")
  export const sign = signatures.sign
  export const verify = signatures.verify
}
