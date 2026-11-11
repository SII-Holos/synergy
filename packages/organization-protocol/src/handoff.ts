import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol } from "./core.js"
import { SigningSignature, digestProtocol, signedProtocol } from "./signature.js"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"

export namespace OrganizationHandoffProtocol {
  export const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  export const Requirement = z.strictObject({
    code: Identity.ID,
    label: z.string().min(1).max(1024),
    recoverable: z.boolean(),
  })
  export const Phase = z.enum([
    "preparing",
    "prepared",
    "surrendered",
    "committed",
    "activation_permitted",
    "completed",
    "cancelled",
    "retired",
  ])
  const Binding = z.strictObject({
    schemaVersion: z.literal(1),
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
  })
  function sameBinding(left: z.infer<typeof Binding>, right: z.infer<typeof Binding>) {
    return Object.keys(Binding.shape).every(
      (field) => left[field as keyof z.infer<typeof Binding>] === right[field as keyof z.infer<typeof Binding>],
    )
  }
  export const Proof = z
    .discriminatedUnion("purpose", [
      Binding.extend({
        purpose: z.literal("source-frozen"),
        manifestHash: Hash,
        commandSeq: Identity.Revision,
        receivedSeq: Identity.Revision,
        compatibilityHash: Hash,
        closureHash: Hash,
        workspaceMoveReceiptHash: Hash.nullable(),
        paused: z.literal(true),
        drained: z.literal(true),
      }),
      Binding.extend({
        purpose: z.literal("target-prepared"),
        manifestHash: Hash,
        compatibilityHash: Hash,
        convertedHash: Hash,
        closureHash: Hash,
        workspaceMoveReceiptHash: Hash.nullable(),
        paused: z.literal(true),
      }),
      Binding.extend({
        purpose: z.literal("source-surrendered"),
        manifestHash: Hash,
        permitID: Identity.ID,
        preparedHash: Hash,
        gatePersisted: z.literal(true),
      }),
      Binding.extend({
        purpose: z.literal("source-cancelled"),
        manifestHash: Hash.nullable(),
        gateCancelled: z.literal(true),
        paused: z.literal(true),
      }),
      Binding.extend({
        purpose: z.literal("target-activated"),
        manifestHash: Hash,
        permitID: Identity.ID,
        preparedHash: Hash,
        paused: z.literal(true),
      }),
      Binding.extend({
        purpose: z.literal("target-never-activate"),
        manifestHash: Hash,
        preparedHash: Hash,
        tombstonePersisted: z.literal(true),
      }),
    ])
    .meta({ ref: "OrgHandoffProof" })
  export type Proof = z.infer<typeof Proof>
  export const SignedProof = z
    .strictObject({ proof: Proof, signature: SigningSignature })
    .meta({ ref: "OrgHandoffSignedProof" })
  export type SignedProof = z.infer<typeof SignedProof>
  const proofs = signedProtocol(Proof, "synergy.organization.handoff.fact.v1\n")
  export const signProof = proofs.sign
  export const verifyProof = proofs.verify
  export const proofHash = (proof: Proof) => digestProtocol(Proof, "synergy.organization.handoff.fact.v1\n", proof)
  export const Permit = Binding.extend({
    purpose: z.enum(["handoff-surrender", "handoff-activation"]),
    permitID: Identity.ID,
    keyID: Identity.ID,
    sourceBinding: OrganizationProtocol.SessionBinding.optional(),
    manifestHash: Hash,
    preparedHash: Hash,
    createdAt: z.number().int().nonnegative().safe(),
  }).meta({ ref: "OrgHandoffPermit" })
  export type Permit = z.infer<typeof Permit>
  export const SignedPermit = z
    .strictObject({ permit: Permit, signature: SigningSignature })
    .meta({ ref: "OrgHandoffSignedPermit" })
  export type SignedPermit = z.infer<typeof SignedPermit>
  const permits = signedProtocol(Permit, "synergy.organization.handoff.permit.v1\n")
  export const signPermit = permits.sign
  export const verifyPermit = permits.verify
  export const PermitRequest = z
    .strictObject({ purpose: z.enum(["handoff-surrender", "handoff-activation"]) })
    .meta({ ref: "OrgHandoffPermitRequest" })
  export type PermitRequest = z.infer<typeof PermitRequest>
  export const Prepare = z
    .strictObject({
      handoffID: Identity.ID,
      targetRuntimeID: Identity.ID,
      expectedBindingEpoch: OrganizationProtocol.Epoch,
      expectedControlRevision: Identity.Revision,
      mappingPlanRevision: z.number().int().positive().safe(),
    })
    .meta({ ref: "OrgHandoffPrepare" })
  export type Prepare = z.infer<typeof Prepare>
  export const Accept = z
    .strictObject({ mappingPlanRevision: z.number().int().positive().safe() })
    .meta({ ref: "OrgHandoffAccept" })
  export type Accept = z.infer<typeof Accept>
  export const View = Binding.extend({
    phase: Phase,
    initiator: Identity.ID,
    targetAccepted: z.boolean(),
    commandSeq: Identity.Revision,
    manifestHash: Hash.optional(),
    missingRequirements: z.array(Requirement),
    canCancel: z.boolean(),
    canAccept: z.boolean(),
    canContinue: z.boolean(),
    currentDriver: Identity.ID,
    bindingEpoch: OrganizationProtocol.Epoch,
  }).meta({ ref: "OrgHandoffView" })
  export type View = z.infer<typeof View>
  export const Page = z
    .strictObject({ items: z.array(View), cursor: Identity.ID.optional() })
    .meta({ ref: "OrgHandoffPage" })

  export const DriveOperation = z.enum([
    "inspect-source",
    "inspect-target",
    "prepare-source",
    "prepare-target",
    "surrender-source",
    "cancel-source",
    "activate-target",
    "retire-target",
  ])
  export const Drive = z
    .strictObject({
      requestID: Identity.ID,
      operation: DriveOperation,
      expectedRevision: Hash.optional(),
      cursor: Identity.ID.optional(),
    })
    .refine((value) => !value.cursor || value.operation.startsWith("inspect-"), "Only inspection can page requirements")
    .meta({ ref: "OrgHandoffDrive" })
  export type Drive = z.infer<typeof Drive>
  export const MachineOperation = z.enum([...DriveOperation.options, "object"])
  export type MachineOperation = z.infer<typeof MachineOperation>
  export function machineRole(operation: MachineOperation) {
    return operation === "object" || operation.endsWith("-source") ? "source" : "target"
  }
  export const ObjectRange = z.strictObject({
    hash: Hash,
    offset: z.number().int().nonnegative().safe(),
    length: z
      .number()
      .int()
      .min(1)
      .max(128 * 1024),
  })
  export const MachinePlan = Binding.extend({
    purpose: z.literal("handoff-machine"),
    requestID: Identity.ID,
    keyID: Identity.ID,
    runtimeID: Identity.ID,
    connectionEpoch: OrganizationProtocol.Epoch,
    operation: MachineOperation,
    sourceBinding: OrganizationProtocol.SessionBinding,
    commandSeq: Identity.Revision,
    controlRevision: Identity.Revision,
    authRevision: Identity.Revision,
    actor: ActorStamp.Info,
    issuedAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().nonnegative().safe(),
    expectedRevision: Hash.optional(),
    cursor: Identity.ID.optional(),
    manifestHash: Hash.optional(),
    preparedHash: Hash.optional(),
    frozen: SignedProof.optional(),
    authorization: SignedPermit.optional(),
    object: ObjectRange.optional(),
  })
    .refine(
      (value) =>
        value.toEpoch > value.fromEpoch &&
        value.sourceBinding.orgID === value.orgID &&
        value.sourceBinding.driverRuntimeID === value.sourceRuntimeID &&
        value.sourceBinding.bindingEpoch === value.fromEpoch &&
        value.actor.kind !== "local" &&
        value.actor.orgID === value.orgID &&
        value.actor.requestID === value.requestID &&
        (value.operation === "object"
          ? value.actor.kind === "system" &&
            value.actor.clientKind === "runtime" &&
            value.actor.subjectID === value.targetRuntimeID
          : value.actor.kind === "account" &&
            value.actor.clientKind !== "runtime" &&
            value.actor.clientKind !== "system") &&
        value.runtimeID === (machineRole(value.operation) === "source" ? value.sourceRuntimeID : value.targetRuntimeID),
      "Machine control requires its canonical source and exact destination",
    )
    .refine(
      (value) => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= 30_000,
      "Machine control has a finite authorization window",
    )
    .refine(
      (value) => (value.operation === "object") === !!value.object,
      "Object data requires a scoped object request",
    )
    .refine(
      (value) =>
        !["prepare-target", "surrender-source", "activate-target", "retire-target", "object"].includes(
          value.operation,
        ) || !!value.manifestHash,
      "This machine operation requires the frozen manifest",
    )
    .refine((value) => !value.cursor || value.operation.startsWith("inspect-"), "Only inspection can page requirements")
    .refine((value) => {
      const required =
        value.operation === "surrender-source"
          ? "handoff-surrender"
          : value.operation === "activate-target"
            ? "handoff-activation"
            : undefined
      if (!required) return !value.authorization
      const permit = value.authorization?.permit
      return (
        !!permit &&
        permit.purpose === required &&
        sameBinding(value, permit) &&
        permit.manifestHash === value.manifestHash &&
        JSON.stringify(permit.sourceBinding) === JSON.stringify(value.sourceBinding)
      )
    }, "Machine publication requires its separately issued handoff permit")
    .refine((value) => {
      const frozen = value.frozen?.proof
      return (
        !frozen ||
        (frozen.purpose === "source-frozen" && sameBinding(value, frozen) && frozen.manifestHash === value.manifestHash)
      )
    }, "Machine source proof must describe this frozen handoff")
    .meta({ ref: "OrgHandoffMachinePlan" })
  export type MachinePlan = z.infer<typeof MachinePlan>
  export const SignedMachinePlan = z
    .strictObject({ plan: MachinePlan, signature: SigningSignature })
    .meta({ ref: "OrgHandoffSignedMachinePlan" })
  export type SignedMachinePlan = z.infer<typeof SignedMachinePlan>
  const machinePlans = signedProtocol(MachinePlan, "synergy.organization.handoff.machine.v1\n")
  export const signMachinePlan = machinePlans.sign
  export const verifyMachinePlan = machinePlans.verify

  export const ObjectChunk = z
    .strictObject({
      hash: Hash,
      offset: z.number().int().nonnegative().safe(),
      nextOffset: z.number().int().nonnegative().safe(),
      totalBytes: z.number().int().nonnegative().safe(),
      data: z
        .string()
        .regex(/^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}|[A-Za-z0-9_-]{3})?$/)
        .max(174_763),
      complete: z.boolean(),
    })
    .refine(
      (value) =>
        value.offset <= value.nextOffset &&
        value.nextOffset <= value.totalBytes &&
        value.nextOffset - value.offset === Math.floor((value.data.length * 3) / 4) &&
        value.complete === (value.nextOffset === value.totalBytes),
      "Object bytes must match their exact window",
    )
  const machineResult = {
    handoffID: Identity.ID,
    requestID: Identity.ID,
    runtimeID: Identity.ID,
    operation: MachineOperation,
    state: z.enum(["idle", "working", "blocked", "complete"]),
    stage: z.enum([
      "idle",
      "preparing",
      "source-frozen",
      "target-prepared",
      "source-surrendered",
      "source-cancelled",
      "target-activated",
      "target-never-activate",
    ]),
    revision: Hash,
    requirements: z.array(Requirement).max(64),
    requirementsCursor: Identity.ID.optional(),
    progress: z
      .strictObject({
        bytes: z.number().int().nonnegative().safe(),
        totalBytes: z.number().int().nonnegative().safe().optional(),
      })
      .optional(),
    readers: z.record(Identity.ID, z.array(z.number().int().positive().safe()).min(1)).optional(),
    object: ObjectChunk.optional(),
  }
  export const MachineExecution = z.strictObject({ ...machineResult, facts: z.array(Proof).max(3) })
  export type MachineExecution = z.infer<typeof MachineExecution>
  export const MachineResult = z
    .strictObject({ ...machineResult, facts: z.array(SignedProof).max(3) })
    .meta({ ref: "OrgHandoffMachineResult" })
  export type MachineResult = z.infer<typeof MachineResult>
  export function matchesMachine(input: unknown, response: unknown) {
    const parsed = MachinePlan.safeParse(input)
    const result = MachineResult.safeParse(response)
    if (!parsed.success || !result.success) return false
    const plan = parsed.data
    const value = result.data
    if (
      value.handoffID !== plan.handoffID ||
      value.requestID !== plan.requestID ||
      value.runtimeID !== plan.runtimeID ||
      value.operation !== plan.operation
    )
      return false
    if (plan.operation === "object") {
      if (
        !value.object ||
        !plan.object ||
        value.object.hash !== plan.object.hash ||
        value.object.offset !== plan.object.offset ||
        value.object.nextOffset - value.object.offset > plan.object.length
      )
        return false
    } else if (value.object) return false
    const completions: Partial<Record<MachineOperation, Proof["purpose"]>> = {
      "prepare-source": "source-frozen",
      "prepare-target": "target-prepared",
      "surrender-source": "source-surrendered",
      "cancel-source": "source-cancelled",
      "activate-target": "target-activated",
      "retire-target": "target-never-activate",
    }
    const completion = completions[plan.operation]
    if (value.state === "complete" && completion && !value.facts.some((fact) => fact.proof.purpose === completion))
      return false
    for (const { proof } of value.facts) {
      if (
        !sameBinding(plan, proof) ||
        (proof.purpose.startsWith("source-") ? "source" : "target") !== machineRole(plan.operation) ||
        (plan.manifestHash && proof.manifestHash !== plan.manifestHash)
      )
        return false
      if (
        proof.purpose === "source-frozen" &&
        (proof.commandSeq !== plan.commandSeq || proof.receivedSeq !== plan.commandSeq)
      )
        return false
      if (
        plan.authorization &&
        (proof.purpose === "source-surrendered" || proof.purpose === "target-activated") &&
        (proof.permitID !== plan.authorization.permit.permitID ||
          proof.preparedHash !== plan.authorization.permit.preparedHash)
      )
        return false
    }
    return true
  }
}
