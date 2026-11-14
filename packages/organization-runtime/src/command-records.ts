import { z } from "zod"
import {
  OrganizationCommandProtocol as Command,
  OrganizationExecutionProtocol as Execution,
  OrganizationIdentity as Identity,
  OrganizationProtocol,
} from "@ericsanchezok/synergy-organization-protocol"

export namespace OrganizationCommandRecords {
  export const RequestIdentity = z.strictObject({
    schemaVersion: z.literal(1),
    orgID: Identity.ID,
    subjectID: Identity.ID,
    requestID: Identity.ID,
    sessionID: Identity.ID,
    projectID: Identity.ID,
    runtimeID: Identity.ID,
    operation: Command.Operation,
    payloadHash: OrganizationProtocol.Digest,
  })
  export const Request = z
    .strictObject({ identity: RequestIdentity, accepted: Command.Accepted.optional() })
    .refine(
      (value) => !value.accepted || JSON.stringify(value.identity) === JSON.stringify(identity(value.accepted.permit)),
      "Accepted effect must belong to its logical request",
    )
  export const State = z.strictObject({
    schemaVersion: z.literal(1),
    orgID: Identity.ID,
    sessionID: Identity.ID,
    projectID: Identity.ID,
    runtimeID: Identity.ID,
    bindingEpoch: OrganizationProtocol.Epoch,
    commandSeq: Identity.Revision,
  })
  export const Slot = z.strictObject({ schemaVersion: z.literal(1), attemptID: Identity.ID })
  export const Counter = z.strictObject({ schemaVersion: z.literal(1), intakeSeq: Identity.Revision })
  export const Lookup = z.strictObject({ subjectID: Identity.ID, requestID: Identity.ID })
  export const SessionRequest = Lookup.extend({ schemaVersion: z.literal(1) })
  export const ControlState = z.strictObject({ schemaVersion: z.literal(1), controlVersion: Command.ControlVersion })
  export const Release = z.strictObject({
    schemaVersion: z.literal(1),
    orgID: Identity.ID,
    subjectID: Identity.ID,
    requestID: Identity.ID,
    sessionID: Identity.ID,
    projectID: Identity.ID,
    runtimeID: Identity.ID,
    bindingEpoch: OrganizationProtocol.Epoch,
    rootID: Identity.ID,
    grantID: Identity.ID,
    actor: Command.Actor,
    admissionID: Identity.ID,
    attemptID: Identity.ID,
    acceptedAt: z.number().int().nonnegative(),
    state: z.enum(["pending", "released"]),
    receipt: Execution.ReleaseReceipt.optional(),
    reconciledAt: z.number().int().nonnegative().optional(),
  })
  export function identity(permit: Command.Permit) {
    return RequestIdentity.parse({
      schemaVersion: 1,
      orgID: permit.orgID,
      subjectID: permit.actor.subjectID,
      requestID: permit.requestID,
      sessionID: permit.sessionID,
      projectID: permit.projectID,
      runtimeID: permit.runtimeID,
      operation: permit.operation,
      payloadHash: permit.payloadHash,
    })
  }
}
