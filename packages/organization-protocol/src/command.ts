import { z } from "zod"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Protocol } from "./core.js"
import { SigningPublicKey, SigningSignature, digestProtocol, signedProtocol } from "./signature.js"

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

  export const Input = z
    .strictObject({
      operation: z.literal("input"),
      mode: z.enum(["task", "steer", "context"]),
      parts: z
        .array(z.strictObject({ type: z.literal("text"), text: z.string().min(1).max(32_768) }))
        .min(1)
        .max(32),
    })
    .refine(
      (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 32_768,
      "Inline input is too large",
    )
    .meta({ ref: "OrgCommandInput" })
  export type Input = z.infer<typeof Input>
  export const InputRequest = z
    .strictObject({
      schemaVersion: z.literal(1),
      orgID: Identity.ID,
      requestID: Identity.ID,
      sessionID: Identity.ID,
      projectID: Identity.ID,
      runtimeID: Identity.ID,
      input: Input,
    })
    .meta({ ref: "OrgCommandInputRequest" })
  export type InputRequest = z.infer<typeof InputRequest>
  export function inputRequest(permit: Permit, input: Input): InputRequest {
    return InputRequest.parse({
      schemaVersion: 1,
      orgID: permit.orgID,
      requestID: permit.requestID,
      sessionID: permit.sessionID,
      projectID: permit.projectID,
      runtimeID: permit.runtimeID,
      input,
    })
  }
  export function digestInput(request: InputRequest) {
    return digestProtocol(InputRequest, "synergy.organization.command.input.v1\n", request)
  }
  export const InputDelivery = z
    .strictObject({ authorization: SignedPermit, input: Input })
    .refine((value) => value.authorization.permit.operation === "input", "Input requires an input permit")
  export type InputDelivery = z.infer<typeof InputDelivery>

  export const SkipPermit = z
    .strictObject({
      schemaVersion: z.literal(1),
      purpose: z.literal("session-command-skip"),
      command: Permit,
      connectionEpoch: Protocol.Epoch,
      authorizedAt: z.number().int().nonnegative(),
      deadline: z.number().int().nonnegative(),
    })
    .refine(
      (value) => value.deadline > value.authorizedAt && value.deadline - value.authorizedAt <= 60_000,
      "Skip permit lifetime must be positive and at most one minute",
    )
  export type SkipPermit = z.infer<typeof SkipPermit>
  export const SignedSkip = z.strictObject({ permit: SkipPermit, signature: SigningSignature })
  export type SignedSkip = z.infer<typeof SignedSkip>
  const skips = signedProtocol(SkipPermit, "synergy.organization.command.skip.v1\n")
  export const signSkip = skips.sign
  export const verifySkip = skips.verify

  export const Rejection = z.enum([
    "EXPIRED_PERMIT",
    "STALE_CONNECTION",
    "STALE_BINDING",
    "SESSION_UNAVAILABLE",
    "TRANSFER_BLOCKED",
    "SEQUENCE_GAP",
    "SEQUENCE_CLOSED",
    "REQUEST_CONFLICT",
    "PAYLOAD_MISMATCH",
  ])
  export type Rejection = z.infer<typeof Rejection>
  export const Accepted = z
    .strictObject({
      schemaVersion: z.literal(1),
      permit: Permit,
      acceptedAt: z.number().int().nonnegative(),
      intakeSeq: Protocol.Epoch,
      effect: z.strictObject({
        kind: z.literal("inbox"),
        itemID: Identity.ID,
        messageID: Identity.ID,
        mode: Input.shape.mode,
      }),
    })
    .refine(
      (value) =>
        value.permit.operation === "input" &&
        value.acceptedAt >= value.permit.authorizedAt &&
        value.acceptedAt < value.permit.deadline,
      "Accepted input must identify an input permit and its valid reception window",
    )
    .meta({ ref: "OrgCommandAccepted" })
  export type Accepted = z.infer<typeof Accepted>
  const attempt = {
    schemaVersion: z.literal(1),
    permit: Permit,
    receivedAt: z.number().int().nonnegative(),
  }
  export const Attempt = z.discriminatedUnion("status", [
    z.strictObject({ ...attempt, status: z.literal("accepted"), acceptedAttemptID: Identity.ID }),
    z.strictObject({ ...attempt, status: z.literal("rejected"), reason: Rejection }),
    z.strictObject({ ...attempt, status: z.literal("skipped") }),
  ])
  export type Attempt = z.infer<typeof Attempt>
  export const SkipReceipt = z.strictObject({
    schemaVersion: z.literal(1),
    permit: SkipPermit,
    receivedAt: z.number().int().nonnegative(),
  })
  export const Result = z.strictObject({
    attempt: Attempt,
    accepted: Accepted.optional(),
    skip: SkipReceipt.optional(),
  })
  export type Result = z.infer<typeof Result>
  export const QueryResult = z
    .strictObject({ authorization: SignedPermit, result: Result.optional() })
    .refine((value) => {
      if (!value.result) return true
      const original = value.authorization.permit
      const found = value.result.attempt.permit
      return (
        original.actor.subjectID === found.actor.subjectID &&
        (["orgID", "requestID", "sessionID", "projectID", "runtimeID", "operation", "payloadHash"] as const).every(
          (key) => original[key] === found[key],
        )
      )
    }, "Receipt query must return the same logical command")
  export type QueryResult = z.infer<typeof QueryResult>
  export const Delivery = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("input"), delivery: InputDelivery }),
    z.strictObject({ kind: z.literal("query"), authorization: SignedPermit }),
    z.strictObject({ kind: z.literal("skip"), authorization: SignedSkip }),
  ])
  export type Delivery = z.infer<typeof Delivery>
  export const Reply = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("result"), result: Result }),
    z.strictObject({ kind: z.literal("query"), query: QueryResult }),
    z.strictObject({ kind: z.literal("error"), error: Protocol.Error }),
  ])
  export type Reply = z.infer<typeof Reply>
  export const AttemptState = z.enum(["admitted", "dispatching", "not_dispatched", "unknown", "accepted", "rejected"])
  export const View = z
    .strictObject({
      requestID: Identity.ID,
      attemptID: Identity.ID,
      state: AttemptState,
      authorizedAt: z.number().int().nonnegative(),
      result: Result.optional(),
      accepted: Accepted.optional(),
    })
    .meta({ ref: "OrgCommandView" })
}
