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
        .array(z.strictObject({ type: z.literal("text"), text: z.string().min(1).max(1_048_576) }))
        .min(1)
        .max(128),
    })
    .refine(
      (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 4 * 1024 * 1024,
      "Input payload is too large",
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
  export const Creation = z.strictObject({
    operation: z.literal("create"),
    title: z.string().min(1).max(512).optional(),
  })
  export type Creation = z.infer<typeof Creation>
  export const CreateRequest = z
    .strictObject({
      schemaVersion: z.literal(1),
      orgID: Identity.ID,
      requestID: Identity.ID,
      projectID: Identity.ID,
      runtimeID: Identity.ID,
      creation: Creation,
    })
    .meta({ ref: "OrgCommandCreateRequest" })
  export type CreateRequest = z.infer<typeof CreateRequest>
  export const CreateTarget = CreateRequest.extend({ sessionID: Identity.ID })
  export type CreateTarget = z.infer<typeof CreateTarget>
  export function createRequest(permit: Permit, creation: Creation): CreateTarget {
    return CreateTarget.parse({
      schemaVersion: 1,
      orgID: permit.orgID,
      requestID: permit.requestID,
      projectID: permit.projectID,
      runtimeID: permit.runtimeID,
      sessionID: permit.sessionID,
      creation,
    })
  }
  export function digestCreate(request: CreateTarget) {
    return digestProtocol(CreateTarget, "synergy.organization.command.create.v1\n", request)
  }
  export const CreateDelivery = z
    .strictObject({ authorization: SignedPermit, creation: Creation })
    .refine((value) => value.authorization.permit.operation === "create", "Creation requires a create permit")
  export type CreateDelivery = z.infer<typeof CreateDelivery>

  export const ControlVersion = z.number().int().nonnegative().safe()
  const PausedSince = z.number().int().nonnegative().safe()
  export const Control = z
    .discriminatedUnion("operation", [
      z.strictObject({ operation: z.literal("pause") }),
      z.strictObject({ operation: z.literal("continue"), pausedSince: PausedSince, controlVersion: ControlVersion }),
      z.strictObject({ operation: z.literal("cancel"), runID: Identity.ID, controlVersion: ControlVersion }),
    ])
    .meta({ ref: "OrgCommandControl" })
  export type Control = z.infer<typeof Control>
  export const ControlRequest = InputRequest.omit({ input: true })
    .extend({ control: Control })
    .meta({ ref: "OrgCommandControlRequest" })
  export type ControlRequest = z.infer<typeof ControlRequest>
  export function controlRequest(permit: Permit, control: Control): ControlRequest {
    return ControlRequest.parse({
      schemaVersion: 1,
      orgID: permit.orgID,
      requestID: permit.requestID,
      sessionID: permit.sessionID,
      projectID: permit.projectID,
      runtimeID: permit.runtimeID,
      control,
    })
  }
  export function digestControl(request: ControlRequest) {
    return digestProtocol(ControlRequest, "synergy.organization.command.control.v1\n", request)
  }
  export const ControlDelivery = z
    .strictObject({ authorization: SignedPermit, control: Control })
    .refine(
      (value) => value.authorization.permit.operation === value.control.operation,
      "Control requires a matching operation permit",
    )
  export type ControlDelivery = z.infer<typeof ControlDelivery>

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
    "CONTROL_CONFLICT",
  ])
  export type Rejection = z.infer<typeof Rejection>
  const acceptance = {
    schemaVersion: z.literal(1),
    permit: Permit,
    acceptedAt: z.number().int().nonnegative(),
    intakeSeq: Protocol.Epoch,
  }
  export const InputAccepted = z
    .strictObject({
      ...acceptance,
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
    .meta({ ref: "OrgCommandInputAccepted" })
  export type InputAccepted = z.infer<typeof InputAccepted>
  export const CreatedAccepted = z
    .strictObject({
      ...acceptance,
      effect: z.strictObject({ kind: z.literal("session"), sessionID: Identity.ID }),
    })
    .refine(
      (value) =>
        value.permit.operation === "create" &&
        value.effect.sessionID === value.permit.sessionID &&
        value.acceptedAt >= value.permit.authorizedAt &&
        value.acceptedAt < value.permit.deadline,
      "Created Session must match its permit and reception window",
    )
    .meta({ ref: "OrgCommandCreatedAccepted" })
  export type CreatedAccepted = z.infer<typeof CreatedAccepted>
  const controlEffect = {
    kind: z.literal("control"),
    controlVersion: ControlVersion.positive(),
    pausedSince: PausedSince,
  }
  const RunStatus = z.enum(["running", "completed", "failed", "cancelled", "interrupted"])
  export const ControlAccepted = z
    .strictObject({
      ...acceptance,
      effect: z.discriminatedUnion("operation", [
        z.strictObject({ ...controlEffect, operation: z.literal("pause"), changed: z.boolean() }),
        z.strictObject({
          ...controlEffect,
          operation: z.literal("continue"),
          itemID: Identity.ID,
          messageID: Identity.ID,
          rootID: Identity.ID.optional(),
        }),
        z.strictObject({
          kind: z.literal("control"),
          operation: z.literal("cancel"),
          controlVersion: ControlVersion.positive(),
          runID: Identity.ID,
          runStatusAtReception: RunStatus,
          cancelRequestedAt: z.number().int().nonnegative().optional(),
        }),
      ]),
    })
    .refine(
      (value) =>
        value.permit.operation === value.effect.operation &&
        value.acceptedAt >= value.permit.authorizedAt &&
        value.acceptedAt < value.permit.deadline,
      "Accepted control must match its operation and reception window",
    )
    .meta({ ref: "OrgCommandControlAccepted" })
  export type ControlAccepted = z.infer<typeof ControlAccepted>
  export const Accepted = z.union([InputAccepted, CreatedAccepted, ControlAccepted]).meta({ ref: "OrgCommandAccepted" })
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
  export const InputResult = Result.extend({ accepted: InputAccepted.optional() })
  export type InputResult = z.infer<typeof InputResult>
  export const CreatedResult = Result.extend({ accepted: CreatedAccepted.optional() })
  export type CreatedResult = z.infer<typeof CreatedResult>
  export const ControlResult = Result.extend({ accepted: ControlAccepted.optional() })
  export type ControlResult = z.infer<typeof ControlResult>
  export const ExecutionObservation = z
    .discriminatedUnion("state", [
      z.strictObject({
        state: z.literal("observed"),
        runID: Identity.ID,
        controlVersion: ControlVersion,
        activity: z.strictObject({
          observedAt: z.number().int().nonnegative(),
          run: z.strictObject({
            id: Identity.ID,
            status: RunStatus,
            recording: z.enum(["partial", "complete", "failed"]),
            cancelRequestedAt: z.number().int().nonnegative().optional(),
            active: z.boolean(),
          }),
          runsObserved: z.number().int().positive(),
          activeExecutions: z.number().int().nonnegative(),
          processes: z.strictObject({
            active: z.number().int().nonnegative(),
            exited: z.number().int().nonnegative(),
            unknown: z.number().int().nonnegative(),
          }),
          scope: z.literal("recorded_subtree"),
          truncated: z.boolean(),
        }),
      }),
      z.strictObject({
        state: z.literal("unavailable"),
        runID: Identity.ID,
        reason: z.enum([
          "runtime_offline",
          "binding_changed",
          "transfer_in_progress",
          "state_changed",
          "run_unavailable",
          "query_failed",
        ]),
      }),
    ])
    .refine(
      (value) => value.state !== "observed" || value.runID === value.activity.run.id,
      "Execution observation must identify its root",
    )
    .meta({ ref: "OrgCommandExecutionObservation" })
  export type ExecutionObservation = z.infer<typeof ExecutionObservation>
  function matchesExecution(execution: ExecutionObservation | undefined, accepted: Accepted | undefined) {
    if (!execution) return true
    if (accepted?.effect.kind !== "control" || accepted.effect.operation !== "cancel") return false
    return (
      execution.runID === accepted.effect.runID &&
      (execution.state !== "observed" ||
        (execution.controlVersion >= accepted.effect.controlVersion &&
          execution.activity.observedAt >= accepted.acceptedAt))
    )
  }
  export const QueryResult = z
    .strictObject({
      authorization: SignedPermit,
      result: Result.optional(),
      execution: ExecutionObservation.optional(),
    })
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
    .refine(
      (value) => matchesExecution(value.execution, value.result?.accepted),
      "Execution observation must belong to the accepted cancellation",
    )
  export type QueryResult = z.infer<typeof QueryResult>
  export const Delivery = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("input"), delivery: InputDelivery }),
    z.strictObject({ kind: z.literal("create"), delivery: CreateDelivery }),
    z.strictObject({ kind: z.literal("control"), delivery: ControlDelivery }),
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
      execution: ExecutionObservation.optional(),
    })
    .refine(
      (value) => matchesExecution(value.execution, value.accepted),
      "Execution observation must belong to the accepted cancellation",
    )
    .meta({ ref: "OrgCommandView" })
}
