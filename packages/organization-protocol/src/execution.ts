import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Protocol } from "./core.js"
import { OrganizationCommandProtocol as Command } from "./command.js"
import { OrganizationResourceProtocol as Resource } from "./resource.js"
import { SigningSignature, signedProtocol } from "./signature.js"

export namespace OrganizationExecutionProtocol {
  export const Selection = z
    .strictObject({
      modelResourceID: Identity.ID,
      connectionResourceIDs: z.array(Identity.ID).max(32),
    })
    .refine(
      (value) =>
        new Set([value.modelResourceID, ...value.connectionResourceIDs]).size ===
        value.connectionResourceIDs.length + 1,
      "Resource selection must contain unique identities",
    )
  export type Selection = z.infer<typeof Selection>
  export function resourceIDs(selection: Selection) {
    return [selection.modelResourceID, ...selection.connectionResourceIDs]
  }
  export const Contract = z
    .strictObject({
      sessionID: Identity.ID,
      revision: Identity.Revision,
      selection: Selection.nullable(),
    })
    .meta({ ref: "OrgSessionResourceContract" })
  export type Contract = z.infer<typeof Contract>
  export const Change = z
    .strictObject({
      expectedRevision: Identity.Revision,
      selection: Selection,
    })
    .meta({ ref: "OrgSessionResourceChange" })
  export type Change = z.infer<typeof Change>
  export const Limits = z.strictObject({
    requestBytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    responseBytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
  })
  export const ReleaseOutcome = z.enum(["completed", "failed", "cancelled"])
  export const Retention = z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("held"), generation: z.number().int().positive().safe() }),
    z.strictObject({
      state: z.literal("released"),
      generation: z.number().int().positive().safe(),
      releasedAt: z.number().int().nonnegative(),
      outcome: ReleaseOutcome,
    }),
  ])
  const GrantFields = z.strictObject({
    schemaVersion: z.literal(3),
    grantID: Identity.ID,
    orgID: Identity.ID,
    deploymentIncarnation: Identity.ID,
    sessionID: Identity.ID,
    projectID: Identity.ID,
    runtimeID: Identity.ID,
    bindingEpoch: Protocol.Epoch,
    selectionRevision: Identity.Revision,
    selection: Selection,
    limits: Limits,
    actor: Command.Actor,
    admissionID: Identity.ID,
    attemptID: Identity.ID,
    createdAt: z.number().int().nonnegative(),
  })
  export const BoundGrant = GrantFields.extend({
    state: z.literal("bound"),
    rootID: Identity.ID,
    boundAt: z.number().int().nonnegative(),
    retention: Retention,
  }).meta({ ref: "OrgBoundExecutionGrant" })
  export type BoundGrant = z.infer<typeof BoundGrant>
  export const Grant = z
    .discriminatedUnion("state", [
      GrantFields.extend({ state: z.literal("provisional") }),
      BoundGrant,
      GrantFields.extend({ state: z.literal("closed"), closedAt: z.number().int().nonnegative() }),
    ])
    .refine((value) => value.actor.orgID === value.orgID, "Grant actor belongs to another organization")
    .meta({ ref: "OrgExecutionGrant" })
  export type Grant = z.infer<typeof Grant>
  const ReceivedProof = z
    .strictObject({
      schemaVersion: z.literal(1),
      orgID: Identity.ID,
      deploymentIncarnation: Identity.ID,
      runtimeID: Identity.ID,
      connectionEpoch: Protocol.Epoch,
      receipt: Command.InputResult,
      issuedAt: z.number().int().nonnegative(),
      expiresAt: z.number().int().nonnegative(),
    })
    .refine(
      (value) => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= 60_000,
      "Binding proof must have a finite window of at most one minute",
    )
    .refine((value) => {
      const accepted = value.receipt.accepted
      if (!accepted || value.receipt.attempt.status !== "accepted" || accepted.effect.mode !== "task") return false
      const permit = accepted.permit
      return (
        permit.orgID === value.orgID &&
        permit.deploymentIncarnation === value.deploymentIncarnation &&
        permit.runtimeID === value.runtimeID &&
        permit.connectionEpoch <= value.connectionEpoch &&
        !!permit.provisionalGrantID
      )
    }, "Execution preparation requires an accepted task receipt")
  export const DescriptionProof = ReceivedProof.safeExtend({
    purpose: z.literal("execution-resource-description"),
  }).meta({ ref: "OrgExecutionDescriptionProof" })
  export type DescriptionProof = z.infer<typeof DescriptionProof>
  export const DescriptionRequest = z
    .strictObject({ proof: DescriptionProof, signature: SigningSignature })
    .meta({ ref: "OrgExecutionDescriptionRequest" })
  export type DescriptionRequest = z.infer<typeof DescriptionRequest>
  export const Description = z
    .strictObject({
      grant: Grant,
      resources: z
        .array(
          z.strictObject({
            resourceID: Identity.ID,
            revision: Identity.Revision,
            name: Identity.Name,
            definition: Resource.Definition,
          }),
        )
        .min(1)
        .max(33),
    })
    .refine((value) => {
      const ids = resourceIDs(value.grant.selection)
      return (
        value.grant.state !== "closed" &&
        value.resources.length === ids.length &&
        value.resources.every(
          (resource, index) =>
            resource.resourceID === ids[index] &&
            Resource.kind(resource.definition) === (index === 0 ? "model" : "connection"),
        )
      )
    }, "Execution descriptors must match the exact active grant selection")
    .meta({ ref: "OrgExecutionDescription" })
  export type Description = z.infer<typeof Description>
  const descriptionSignatures = signedProtocol(DescriptionProof, "synergy.organization.execution.resources.v1\n")
  export const signDescription = descriptionSignatures.sign
  export const verifyDescription = descriptionSignatures.verify
  export const BindingProof = ReceivedProof.safeExtend({
    purpose: z.literal("execution-root-binding"),
    rootID: Identity.ID,
  })
    .refine(
      (value) => value.receipt.accepted?.effect.messageID === value.rootID,
      "Binding requires the exact accepted task root",
    )
    .meta({ ref: "OrgExecutionBindingProof" })
  export type BindingProof = z.infer<typeof BindingProof>
  export const BindingRequest = z
    .strictObject({ proof: BindingProof, signature: SigningSignature })
    .meta({ ref: "OrgExecutionBindingRequest" })
  export type BindingRequest = z.infer<typeof BindingRequest>
  const bindingSignatures = signedProtocol(BindingProof, "synergy.organization.execution.root-binding.v1\n")
  export const signBinding = bindingSignatures.sign
  export const verifyBinding = bindingSignatures.verify
  export const ReleaseProof = ReceivedProof.safeExtend({
    purpose: z.literal("execution-resources-release"),
    rootID: Identity.ID,
    generation: z.number().int().nonnegative().safe(),
    outcome: ReleaseOutcome,
  })
    .refine(
      (value) => value.receipt.accepted?.effect.messageID === value.rootID,
      "Release requires the exact accepted task root",
    )
    .refine(
      (value) => value.generation !== 0 || value.outcome === "cancelled",
      "Unmaterialized task resources can only be released after cancellation",
    )
    .meta({ ref: "OrgExecutionReleaseProof" })
  export type ReleaseProof = z.infer<typeof ReleaseProof>
  export const ReleaseRequest = z
    .strictObject({ proof: ReleaseProof, signature: SigningSignature })
    .meta({ ref: "OrgExecutionReleaseRequest" })
  export type ReleaseRequest = z.infer<typeof ReleaseRequest>
  export const ReleaseReceipt = z
    .strictObject({
      schemaVersion: z.literal(1),
      orgID: Identity.ID,
      deploymentIncarnation: Identity.ID,
      runtimeID: Identity.ID,
      sessionID: Identity.ID,
      bindingEpoch: Protocol.Epoch,
      grantID: Identity.ID,
      rootID: Identity.ID,
      generation: z.number().int().nonnegative().safe(),
      outcome: ReleaseOutcome,
      releasedAt: z.number().int().nonnegative(),
    })
    .refine((value) => value.generation !== 0 || value.outcome === "cancelled")
    .meta({ ref: "OrgExecutionReleaseReceipt" })
  export type ReleaseReceipt = z.infer<typeof ReleaseReceipt>
  const releaseSignatures = signedProtocol(ReleaseProof, "synergy.organization.execution.release.v1\n")
  export const signRelease = releaseSignatures.sign
  export const verifyRelease = releaseSignatures.verify
}
