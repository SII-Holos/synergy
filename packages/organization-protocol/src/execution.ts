import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Protocol } from "./core.js"
import { OrganizationCommandProtocol as Command } from "./command.js"
import { OrganizationResourceProtocol as Resource } from "./resource.js"
import { SigningSignature, signedProtocol } from "./signature.js"
import { OrganizationHandoffProtocol as Handoff } from "./handoff.js"

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
  const LegacyRetention = z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("held"), generation: z.number().int().positive().safe() }),
    z.strictObject({
      state: z.literal("released"),
      generation: z.number().int().positive().safe(),
      releasedAt: z.number().int().nonnegative(),
      outcome: ReleaseOutcome,
    }),
  ])
  const HandoffClosure = z.strictObject({
    handoffID: Identity.ID,
    manifestHash: Protocol.Digest,
    preparedHash: Protocol.Digest,
    closedAt: z.number().int().nonnegative(),
  })
  export const Retention = z.discriminatedUnion("state", [
    ...LegacyRetention.options,
    HandoffClosure.extend({ state: z.literal("handoff_closed"), generation: z.number().int().positive().safe() }),
    z.strictObject({
      state: z.literal("control_closed"),
      generation: z.number().int().positive().safe(),
      successorGrantID: Identity.ID,
      closedAt: z.number().int().nonnegative(),
    }),
  ])
  const GrantFields = z.strictObject({
    schemaVersion: z.literal(4),
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
    provenance: z
      .strictObject({
        handoffID: Identity.ID,
        predecessorGrantID: Identity.ID,
        originGrantID: Identity.ID,
        rootID: Identity.ID,
        control: Command.ControlAccepted.refine(
          (value) => value.effect.operation === "continue" && !!value.effect.rootID,
          "Grant continuation requires its exact root",
        ),
      })
      .optional(),
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
      GrantFields.extend({
        state: z.literal("closed"),
        closedAt: z.number().int().nonnegative(),
        handoffClosure: HandoffClosure.extend({ rootID: Identity.ID, generation: z.literal(0) }).optional(),
        controlClosure: z
          .strictObject({
            rootID: Identity.ID,
            successorGrantID: Identity.ID,
            closedAt: z.number().int().nonnegative(),
          })
          .optional(),
      }),
    ])
    .refine((value) => value.actor.orgID === value.orgID, "Grant actor belongs to another organization")
    .meta({ ref: "OrgExecutionGrant" })
  export type Grant = z.infer<typeof Grant>
  const LegacyFields3 = GrantFields.omit({ provenance: true }).extend({ schemaVersion: z.literal(3) })
  export const LegacyGrant3 = z.discriminatedUnion("state", [
    LegacyFields3.extend({ state: z.literal("provisional") }),
    LegacyFields3.extend({
      state: z.literal("bound"),
      rootID: Identity.ID,
      boundAt: z.number().int().nonnegative(),
      retention: LegacyRetention,
    }),
    LegacyFields3.extend({ state: z.literal("closed"), closedAt: z.number().int().nonnegative() }),
  ])
  export const Continuation = z
    .strictObject({ handoffID: Identity.ID, receipt: Command.ControlResult })
    .refine(
      (value) => value.receipt.attempt.status === "accepted" && value.receipt.accepted?.effect.operation === "continue",
      "Execution continuation requires an accepted explicit Continue",
    )
  export type Continuation = z.infer<typeof Continuation>
  const ReceivedProof = z
    .strictObject({
      schemaVersion: z.literal(1),
      orgID: Identity.ID,
      deploymentIncarnation: Identity.ID,
      runtimeID: Identity.ID,
      connectionEpoch: Protocol.Epoch,
      receipt: Command.InputResult,
      continuation: Continuation.optional(),
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
      const continuation = value.continuation?.receipt.accepted
      if (continuation)
        return (
          continuation.effect.operation === "continue" &&
          continuation.effect.rootID === accepted.effect.messageID &&
          continuation.permit.orgID === value.orgID &&
          continuation.permit.deploymentIncarnation === value.deploymentIncarnation &&
          continuation.permit.runtimeID === value.runtimeID &&
          continuation.permit.sessionID === permit.sessionID &&
          continuation.permit.projectID === permit.projectID &&
          continuation.permit.connectionEpoch <= value.connectionEpoch &&
          permit.orgID === value.orgID &&
          permit.deploymentIncarnation === value.deploymentIncarnation &&
          !!permit.provisionalGrantID
        )
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
    grantID: Identity.ID.optional(),
    rootID: Identity.ID,
    generation: z.number().int().nonnegative().safe(),
    outcome: ReleaseOutcome,
    materialized: z.boolean().default(false),
  })
    .refine(
      (value) => value.receipt.accepted?.effect.messageID === value.rootID,
      "Release requires the exact accepted task root",
    )
    .refine((value) => !value.continuation || !!value.grantID, "Continued release requires its exact current grant")
    .refine(
      (value) => value.generation !== 0 || value.outcome === "cancelled" || value.materialized,
      "Unbound task resources require materialized root evidence unless cancelled",
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
      materialized: z.boolean().default(false),
      releasedAt: z.number().int().nonnegative(),
    })
    .refine((value) => value.generation !== 0 || value.outcome === "cancelled" || value.materialized)
    .meta({ ref: "OrgExecutionReleaseReceipt" })
  export type ReleaseReceipt = z.infer<typeof ReleaseReceipt>
  const releaseSignatures = signedProtocol(ReleaseProof, "synergy.organization.execution.release.v1\n")
  export const signRelease = releaseSignatures.sign
  export const verifyRelease = releaseSignatures.verify

  export const InspectionProof = ReceivedProof.safeExtend({
    purpose: z.literal("execution-retention-inspection"),
    rootID: Identity.ID,
    grantID: Identity.ID.optional(),
    generation: z.number().int().nonnegative().safe().optional(),
  })
    .refine(
      (value) => value.receipt.accepted?.effect.messageID === value.rootID,
      "Inspection requires its exact accepted task root",
    )
    .refine(
      (value) => value.generation === undefined || value.grantID !== undefined,
      "A generation selector requires its exact grant",
    )
    .meta({ ref: "OrgExecutionInspectionProof" })
  export type InspectionProof = z.infer<typeof InspectionProof>
  export const InspectionRequest = z
    .strictObject({ proof: InspectionProof, signature: SigningSignature })
    .meta({ ref: "OrgExecutionInspectionRequest" })
  export type InspectionRequest = z.infer<typeof InspectionRequest>
  const inspectionSignatures = signedProtocol(
    InspectionProof,
    "synergy.organization.execution.retention-inspection.v1\n",
  )
  export const signInspection = inspectionSignatures.sign
  export const verifyInspection = inspectionSignatures.verify
  const InspectionEnvelope = z.strictObject({
    schemaVersion: z.literal(1),
    orgID: Identity.ID,
    deploymentIncarnation: Identity.ID,
    runtimeID: Identity.ID,
    connectionEpoch: Protocol.Epoch,
    sessionID: Identity.ID,
    bindingEpoch: Protocol.Epoch,
    rootID: Identity.ID,
    originGrantID: Identity.ID,
    controlAdmissionID: Identity.ID.optional(),
    requestedGrantID: Identity.ID.optional(),
    requestedGeneration: z.number().int().nonnegative().safe().optional(),
    inspectedAt: z.number().int().nonnegative().safe(),
  })
  export const Inspection = z
    .discriminatedUnion("state", [
      InspectionEnvelope.extend({ state: z.literal("known"), grant: Grant, release: ReleaseReceipt.optional() }),
      InspectionEnvelope.extend({ state: z.literal("absent") }),
    ])
    .refine((value) => {
      if (value.requestedGeneration !== undefined && value.requestedGrantID === undefined) return false
      if (value.state === "absent")
        return value.requestedGrantID === undefined && value.controlAdmissionID !== undefined
      const grant = value.grant
      if (
        grant.orgID !== value.orgID ||
        grant.deploymentIncarnation !== value.deploymentIncarnation ||
        grant.runtimeID !== value.runtimeID ||
        grant.sessionID !== value.sessionID ||
        grant.bindingEpoch !== value.bindingEpoch ||
        (grant.state === "bound" && grant.rootID !== value.rootID) ||
        (grant.state === "closed" &&
          ((grant.handoffClosure !== undefined && grant.handoffClosure.rootID !== value.rootID) ||
            (grant.controlClosure !== undefined && grant.controlClosure.rootID !== value.rootID))) ||
        (grant.provenance?.originGrantID ?? grant.grantID) !== value.originGrantID ||
        grant.provenance?.control.permit.admissionID !== value.controlAdmissionID ||
        (value.requestedGrantID !== undefined && grant.grantID !== value.requestedGrantID)
      )
        return false
      const release = value.release
      return (
        !release ||
        (value.requestedGeneration !== undefined &&
          release.generation === value.requestedGeneration &&
          release.orgID === value.orgID &&
          release.deploymentIncarnation === value.deploymentIncarnation &&
          release.runtimeID === value.runtimeID &&
          release.sessionID === value.sessionID &&
          release.bindingEpoch === value.bindingEpoch &&
          release.grantID === grant.grantID &&
          release.rootID === value.rootID)
      )
    }, "Inspection must echo the exact original root, control and selected resource generation")
    .meta({ ref: "OrgExecutionInspection" })
  export type Inspection = z.infer<typeof Inspection>
  export const RetentionRequest = z
    .union([DescriptionRequest, InspectionRequest])
    .meta({ ref: "OrgExecutionRetentionRequest" })
  export type RetentionRequest = z.infer<typeof RetentionRequest>
  export const RetentionResult = z.union([Grant, Inspection]).meta({ ref: "OrgExecutionRetentionResult" })
  export type RetentionResult = z.infer<typeof RetentionResult>

  export const HandoffCloseProof = Handoff.Binding.extend({
    purpose: z.literal("execution-handoff-close"),
    runtimeID: Identity.ID,
    connectionEpoch: Protocol.Epoch,
    grantID: Identity.ID,
    rootID: Identity.ID,
    generation: z.number().int().nonnegative().safe(),
    manifestHash: Protocol.Digest,
    preparedHash: Protocol.Digest,
    receipt: Command.InputResult,
    continuation: Continuation.optional(),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
    .refine((value) => {
      const accepted = value.receipt.accepted
      return (
        value.runtimeID === value.sourceRuntimeID &&
        value.expiresAt > value.issuedAt &&
        value.expiresAt - value.issuedAt <= 30_000 &&
        !!accepted &&
        value.receipt.attempt.status === "accepted" &&
        accepted.effect.mode === "task" &&
        accepted.effect.messageID === value.rootID &&
        !!accepted.permit.provisionalGrantID &&
        accepted.permit.orgID === value.orgID &&
        accepted.permit.sessionID === value.sessionID
      )
    }, "Source handoff closure requires its finite accepted root proof")
    .meta({ ref: "OrgExecutionHandoffCloseProof" })
  export type HandoffCloseProof = z.infer<typeof HandoffCloseProof>
  export const HandoffCloseRequest = z
    .strictObject({ proof: HandoffCloseProof, signature: SigningSignature })
    .meta({ ref: "OrgExecutionHandoffCloseRequest" })
  export type HandoffCloseRequest = z.infer<typeof HandoffCloseRequest>
  export const HandoffCloseReceipt = Handoff.Binding.extend({
    purpose: z.literal("execution-handoff-closed"),
    grantID: Identity.ID,
    rootID: Identity.ID,
    generation: z.number().int().nonnegative().safe(),
    manifestHash: Protocol.Digest,
    preparedHash: Protocol.Digest,
    closedAt: z.number().int().nonnegative(),
  }).meta({ ref: "OrgExecutionHandoffCloseReceipt" })
  export type HandoffCloseReceipt = z.infer<typeof HandoffCloseReceipt>
  const handoffCloseSignatures = signedProtocol(HandoffCloseProof, "synergy.organization.execution.handoff-close.v1\n")
  export const signHandoffClose = handoffCloseSignatures.sign
  export const verifyHandoffClose = handoffCloseSignatures.verify
  export const HandoffInventoryProof = Handoff.Binding.extend({
    purpose: z.literal("execution-handoff-inventory"),
    runtimeID: Identity.ID,
    connectionEpoch: Protocol.Epoch,
    manifestHash: Protocol.Digest,
    preparedHash: Protocol.Digest,
    cursor: Identity.ID.optional(),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
    .refine(
      (value) =>
        value.runtimeID === value.sourceRuntimeID &&
        value.expiresAt > value.issuedAt &&
        value.expiresAt - value.issuedAt <= 30_000,
      "Handoff inventory requires its current finite source participant",
    )
    .meta({ ref: "OrgExecutionHandoffInventoryProof" })
  export type HandoffInventoryProof = z.infer<typeof HandoffInventoryProof>
  export const HandoffInventoryRequest = z
    .strictObject({ proof: HandoffInventoryProof, signature: SigningSignature })
    .meta({ ref: "OrgExecutionHandoffInventoryRequest" })
  export type HandoffInventoryRequest = z.infer<typeof HandoffInventoryRequest>
  const Lookup = z.strictObject({ subjectID: Identity.ID, requestID: Identity.ID })
  export const HandoffInventoryItem = z.strictObject({
    grantID: Identity.ID,
    rootID: Identity.ID,
    generation: z.number().int().nonnegative().safe(),
    originGrantID: Identity.ID,
    lookup: Lookup,
    continuation: z.strictObject({ handoffID: Identity.ID, lookup: Lookup }).optional(),
  })
  export const HandoffInventoryPage = z
    .strictObject({
      binding: Handoff.Binding,
      retained: z.number().int().nonnegative().safe(),
      items: z.array(HandoffInventoryItem).max(64),
      cursor: Identity.ID.optional(),
    })
    .meta({ ref: "OrgExecutionHandoffInventoryPage" })
  export type HandoffInventoryPage = z.infer<typeof HandoffInventoryPage>
  const handoffInventorySignatures = signedProtocol(
    HandoffInventoryProof,
    "synergy.organization.execution.handoff-inventory.v1\n",
  )
  export const signHandoffInventory = handoffInventorySignatures.sign
  export const verifyHandoffInventory = handoffInventorySignatures.verify
}
