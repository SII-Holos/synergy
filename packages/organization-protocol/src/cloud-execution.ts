import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Protocol } from "./core.js"
import { OrganizationExecutionProtocol as Execution } from "./execution.js"
import { OrganizationCloudProtocol as Cloud } from "./cloud.js"
import { digestProtocol, SigningSignature, signedProtocol } from "./signature.js"

export namespace OrganizationCloudExecutionProtocol {
  export const Reference = z
    .strictObject({
      version: z.literal(2),
      nativeOperationID: Identity.ID,
      preparationVersion: z.literal(1),
      orgID: Identity.ID,
      deploymentIncarnation: Identity.ID,
      projectID: Identity.ID,
      runtimeID: Identity.ID,
      sessionID: Identity.ID,
      rootID: Identity.ID,
      bindingEpoch: Protocol.Epoch,
      grantID: Identity.ID,
      retentionGeneration: z.number().int().positive().safe(),
      selectionRevision: Identity.Revision,
      resourceID: Identity.ID,
      environmentID: Identity.ID,
      serviceScopeID: Identity.ID,
      hostOwner: z.literal("organization-environment"),
      leaseID: Identity.ID,
      target: z.json(),
      workspace: Cloud.FileReference,
      mount: z.json(),
      directory: z.string().min(1).max(4096),
    })
    .meta({ ref: "OrgCloudExecutionReference" })
  export type Reference = z.infer<typeof Reference>
  export const HostBinding = z.discriminatedUnion("kind", [
    z.strictObject({
      version: z.literal(1),
      kind: z.literal("admission"),
      grantID: Identity.ID,
      retentionGeneration: z.number().int().positive().safe(),
      leaseID: Identity.ID,
      bindingDigest: Protocol.Digest,
    }),
    z.strictObject({
      version: z.literal(2),
      kind: z.literal("execution"),
      grantID: Identity.ID,
      retentionGeneration: z.number().int().positive().safe(),
      operationID: Identity.ID,
      bindingDigest: Protocol.Digest,
      reference: Reference,
      nativeOrigin: z.json(),
    }),
  ])
  export type HostBinding = z.infer<typeof HostBinding>
  export function hostInvocation(value: HostBinding) {
    const encoded = JSON.stringify(HostBinding.parse(value))
    if (new TextEncoder().encode(encoded).byteLength > 32768)
      throw new Error("Environment Host invocation is too large")
    return encoded
  }
  export function readHostInvocation(value: string) {
    if (new TextEncoder().encode(value).byteLength > 32768) throw new Error("Environment Host invocation is too large")
    const parsed = HostBinding.parse(JSON.parse(value))
    if (hostInvocation(parsed) !== value) throw new Error("Environment Host invocation is not canonical")
    return parsed
  }
  export async function operationIdentity(
    reference: Reference,
    id: string,
    origin: z.infer<ReturnType<typeof z.json>>,
  ) {
    const input = z
      .strictObject({ reference: Reference, id: Identity.ID, origin: z.json() })
      .parse({ reference, id, origin })
    if (input.id !== input.reference.nativeOperationID)
      throw new Error("Environment operation changed its original native identity")
    const bindingDigest = await digestProtocol(
      z.strictObject({ reference: Reference, id: Identity.ID, origin: z.json() }),
      "synergy.organization.environment.execution.v2\n",
      input,
    )
    const operationID = `org_env_${bindingDigest}`
    return {
      operationID,
      invocationID: hostInvocation({
        version: 2,
        kind: "execution",
        grantID: input.reference.grantID,
        retentionGeneration: input.reference.retentionGeneration,
        operationID,
        bindingDigest,
        reference: input.reference,
        nativeOrigin: input.origin,
      }),
    }
  }
  const Selected = z.strictObject({ reference: Reference })
  const Identified = Selected.extend({ id: Identity.ID })
  export const Operation = z
    .discriminatedUnion("action", [
      z.strictObject({
        action: z.literal("resolve"),
        nativeOperationID: Identity.ID,
        capability: z.enum(["exec", "pty"]),
        origin: z.json(),
        workspace: Cloud.FileReference,
      }),
      Selected.extend({ action: z.literal("release-admission") }),
      Identified.extend({ action: z.literal("prepare-inputs"), input: z.json() }),
      Identified.extend({ action: z.literal("discard-inputs") }),
      Identified.extend({ action: z.literal("prepare-sandbox"), input: z.json() }),
      Identified.extend({ action: z.literal("release-sandbox") }),
      Identified.extend({
        action: z.literal("start"),
        request: z.json(),
        origin: z.json(),
        intentDigest: Protocol.Digest.optional(),
      }),
      Identified.extend({ action: z.literal("status") }),
      Identified.extend({
        action: z.literal("output"),
        after: z.number().int().nonnegative().safe(),
        limit: z.number().int().positive().max(128),
      }),
      Identified.extend({ action: z.literal("stdin"), data: z.string().max(87384), end: z.boolean() }),
      Identified.extend({
        action: z.literal("resize"),
        cols: z.number().int().positive().max(65535),
        rows: z.number().int().positive().max(65535),
      }),
      Identified.extend({ action: z.literal("cancel"), digest: Protocol.Digest }),
      Identified.extend({ action: z.literal("complete"), digest: Protocol.Digest }),
    ])
    .meta({ ref: "OrgCloudExecutionOperation" })
  export type Operation = z.infer<typeof Operation>
  export const Proof = z
    .strictObject({
      version: z.literal(2),
      purpose: z.literal("organization-environment-operation"),
      authority: Execution.BindingRequest,
      operation: Operation,
    })
    .meta({ ref: "OrgCloudExecutionProof" })
  export type Proof = z.infer<typeof Proof>
  export const Request = z
    .strictObject({ proof: Proof, signature: SigningSignature })
    .meta({ ref: "OrgCloudExecutionRequest" })
  export type Request = z.infer<typeof Request>
  const signatures = signedProtocol(Proof, "synergy.organization.environment.operation.v2\n")
  export const sign = signatures.sign
  export const verify = signatures.verify
  export const Result = z
    .strictObject({
      reference: Reference,
      action: z.union(Operation.options.map((operation) => operation.shape.action)),
      value: z.json(),
      runtime: z.json().optional(),
    })
    .meta({ ref: "OrgCloudExecutionResult" })
  export type Result = z.infer<typeof Result>
  const Inspection = z.strictObject({
    reference: Reference,
    id: Identity.ID,
    origin: z.json(),
  })
  const ExecutionInspection = Inspection.extend({
    kind: z.literal("execution"),
    digest: Protocol.Digest,
    after: z.number().int().nonnegative().safe(),
    limit: z.number().int().positive().max(128),
  })
  const PreparationInspection = Inspection.extend({ kind: z.literal("preparation") })
  export const InspectionQuery = z.discriminatedUnion("kind", [ExecutionInspection, PreparationInspection])
  export type InspectionQuery = z.infer<typeof InspectionQuery>
  const InspectionAuthority = {
    version: z.literal(2),
    purpose: z.literal("organization-environment-inspection"),
    authority: Execution.InspectionRequest,
  }
  export const InspectionProof = z
    .discriminatedUnion("kind", [
      ExecutionInspection.extend(InspectionAuthority),
      PreparationInspection.extend(InspectionAuthority),
    ])
    .meta({ ref: "OrgCloudExecutionInspectionProof" })
  export type InspectionProof = z.infer<typeof InspectionProof>
  export const InspectionRequest = z
    .strictObject({ proof: InspectionProof, signature: SigningSignature })
    .meta({ ref: "OrgCloudExecutionInspectionRequest" })
  export type InspectionRequest = z.infer<typeof InspectionRequest>
  const inspections = signedProtocol(InspectionProof, "synergy.organization.environment.inspection.v2\n")
  export const signInspection = inspections.sign
  export const verifyInspection = inspections.verify
  export const InspectionResult = z
    .discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("execution"),
        reference: Reference,
        id: Identity.ID,
        digest: Protocol.Digest,
        execution: z.json().nullable(),
        output: z.array(z.json()).max(128),
      }),
      z.strictObject({
        kind: z.literal("preparation"),
        reference: Reference,
        id: Identity.ID,
        preparation: z.json().nullable(),
      }),
    ])
    .meta({ ref: "OrgCloudExecutionInspectionResult" })
  export type InspectionResult = z.infer<typeof InspectionResult>

  const AdmissionRetirement = z.strictObject({ kind: z.literal("admission"), reference: Reference, origin: z.json() })
  const ExecutionRetirement = AdmissionRetirement.extend({
    kind: z.literal("execution"),
    id: Identity.ID,
    digest: Protocol.Digest,
  })
  export const RetirementQuery = z.discriminatedUnion("kind", [AdmissionRetirement, ExecutionRetirement])
  export type RetirementQuery = z.infer<typeof RetirementQuery>
  const retirementAuthority = {
    version: z.literal(2),
    purpose: z.literal("organization-environment-retirement"),
    authority: Execution.InspectionRequest,
  }
  export const RetirementProof = z
    .discriminatedUnion("kind", [
      AdmissionRetirement.extend(retirementAuthority),
      ExecutionRetirement.extend(retirementAuthority),
    ])
    .meta({ ref: "OrgCloudExecutionRetirementProof" })
  export const RetirementRequest = z
    .strictObject({ proof: RetirementProof, signature: SigningSignature })
    .meta({ ref: "OrgCloudExecutionRetirementRequest" })
  export type RetirementRequest = z.infer<typeof RetirementRequest>
  const retirements = signedProtocol(RetirementProof, "synergy.organization.environment.retirement.v2\n")
  export const signRetirement = retirements.sign
  export const verifyRetirement = retirements.verify
  const retirementInspectionAuthority = {
    ...retirementAuthority,
    purpose: z.literal("organization-environment-retirement-inspection"),
  }
  export const RetirementInspectionProof = z
    .discriminatedUnion("kind", [
      AdmissionRetirement.extend(retirementInspectionAuthority),
      ExecutionRetirement.extend(retirementInspectionAuthority),
    ])
    .meta({ ref: "OrgCloudExecutionRetirementInspectionProof" })
  export const RetirementInspectionRequest = z
    .strictObject({ proof: RetirementInspectionProof, signature: SigningSignature })
    .meta({ ref: "OrgCloudExecutionRetirementInspectionRequest" })
  export type RetirementInspectionRequest = z.infer<typeof RetirementInspectionRequest>
  const retirementInspections = signedProtocol(
    RetirementInspectionProof,
    "synergy.organization.environment.retirement-inspection.v2\n",
  )
  export const signRetirementInspection = retirementInspections.sign
  export const verifyRetirementInspection = retirementInspections.verify
  export const RetirementResult = z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("admission"), reference: Reference, released: z.boolean() }),
      z.strictObject({
        kind: z.literal("execution"),
        reference: Reference,
        id: Identity.ID,
        digest: Protocol.Digest,
        execution: z.json().nullable(),
      }),
    ])
    .meta({ ref: "OrgCloudExecutionRetirementResult" })
  export type RetirementResult = z.infer<typeof RetirementResult>
}
