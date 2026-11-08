import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Protocol } from "./core.js"
import { OrganizationCommandProtocol as Command } from "./command.js"
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
    calls: z.number().int().positive().max(4096),
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
  const GrantFields = z.strictObject({
    schemaVersion: z.literal(1),
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
  }).meta({ ref: "OrgBoundExecutionGrant" })
  export type BoundGrant = z.infer<typeof BoundGrant>
  export const Grant = z
    .discriminatedUnion("state", [
      GrantFields.extend({ state: z.literal("provisional") }),
      BoundGrant,
      GrantFields.extend({ state: z.literal("closed"), closedAt: z.number().int().nonnegative() }),
    ])
    .refine((value) => value.actor.orgID === value.orgID, "Grant actor belongs to another organization")
  export type Grant = z.infer<typeof Grant>
  export const BindingProof = z
    .strictObject({
      schemaVersion: z.literal(1),
      purpose: z.literal("execution-root-binding"),
      orgID: Identity.ID,
      deploymentIncarnation: Identity.ID,
      runtimeID: Identity.ID,
      connectionEpoch: Protocol.Epoch,
      rootID: Identity.ID,
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
        !!permit.provisionalGrantID &&
        accepted.effect.messageID === value.rootID
      )
    }, "Binding requires an accepted task and its exact root identity")
    .meta({ ref: "OrgExecutionBindingProof" })
  export type BindingProof = z.infer<typeof BindingProof>
  export const BindingRequest = z
    .strictObject({ proof: BindingProof, signature: SigningSignature })
    .meta({ ref: "OrgExecutionBindingRequest" })
  export type BindingRequest = z.infer<typeof BindingRequest>
  const bindingSignatures = signedProtocol(BindingProof, "synergy.organization.execution.root-binding.v1\n")
  export const signBinding = bindingSignatures.sign
  export const verifyBinding = bindingSignatures.verify
}
