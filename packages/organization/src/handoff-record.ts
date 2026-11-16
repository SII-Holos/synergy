import { z } from "zod"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationProtocol as Organization,
  OrganizationIdentity as Identity,
  OrganizationRuntimeProtocol as Runtime,
} from "@ericsanchezok/synergy-organization-protocol"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import { WorkspaceArchive } from "@ericsanchezok/synergy-harness/workspace/archive"
import { OrganizationRecord as Record } from "./storage/records"

export namespace OrganizationHandoffRecord {
  export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  export const bindingFields = [
    "orgID",
    "deploymentIncarnation",
    "handoffID",
    "sessionID",
    "sourceRuntimeID",
    "targetRuntimeID",
    "fromEpoch",
    "toEpoch",
    "mappingPlanRevision",
    "shareGeneration",
  ] as const
  export const LegacyStored = Handoff.LegacyView.omit({
    missingRequirements: true,
    canCancel: true,
    canAccept: true,
    canContinue: true,
    currentDriver: true,
    bindingEpoch: true,
  }).extend({
    version: z.literal(1),
    request: Handoff.LegacyPrepare,
    source: Runtime.Registration,
    target: Runtime.Registration,
    cancelRequested: z.boolean(),
    frozen: Handoff.SignedProof.optional(),
    prepared: Handoff.SignedProof.optional(),
    surrendered: Handoff.SignedProof.optional(),
    cancelled: Handoff.SignedProof.optional(),
    activated: Handoff.SignedProof.optional(),
    retired: Handoff.SignedProof.optional(),
    surrenderPermit: Handoff.SignedPermit.optional(),
    activationPermit: Handoff.SignedPermit.optional(),
  })
  const MappedStored = LegacyStored.omit({ version: true }).extend({
    request: Handoff.CurrentPrepare,
    selectionActor: ActorStamp.Info.nullable(),
    workspaceContract: Record.SessionResources.optional(),
    workspaceSource: WorkspaceArchive.Subtree.optional(),
  })
  export function sourceSnapshotHash(record: z.infer<typeof MappedStored>) {
    if (record.request.workspaceMapping.kind === "native-existing") {
      const frozen = record.frozen?.proof
      return frozen?.purpose === "source-frozen" && frozen.fileClosureHash ? (frozen.workspaceSourceHash ?? null) : null
    }
    return record.workspaceSource ? WorkspaceArchive.subtreeHash(record.workspaceSource) : null
  }
  const selection = (record: z.infer<typeof MappedStored>) =>
    record.request.workspaceMapping.kind === "native" ||
    (record.selectionActor?.kind === "account" &&
      record.selectionActor.subjectID === record.initiator &&
      record.selectionActor.orgID === record.orgID &&
      record.selectionActor.requestID === record.handoffID)
  export const PreviousStored = MappedStored.extend({ version: z.literal(2) }).refine(
    (record) => !Handoff.isNativeTargetMapping(record.request.workspaceMapping) && selection(record),
    "Version-two handoffs require their original mapping reader",
  )
  const FileStored = MappedStored.extend({
    version: z.union([z.literal(3), z.literal(4), z.literal(5)]),
    targetActor: ActorStamp.Info.optional(),
    difference: Handoff.SignedDifference.optional(),
    differenceConsent: Handoff.DifferenceConsent.optional(),
    differenceActor: ActorStamp.Info.optional(),
    previewReleased: Handoff.SignedProof.optional(),
    sourceBinding: Organization.SessionBinding.optional(),
    sourceControlRevision: Identity.Revision.optional(),
  })
    .refine(
      (record) =>
        record.request.workspaceMapping.kind === "native" ||
        (record.selectionActor?.kind === "account" &&
          record.selectionActor.subjectID === record.initiator &&
          record.selectionActor.orgID === record.orgID &&
          record.selectionActor.requestID === record.handoffID),
      "Object mappings require their original authenticated selection actor",
    )
    .superRefine((record, context) => {
      const invalid = (message: string) => context.addIssue({ code: "custom", message })
      const mapping = record.request.workspaceMapping
      const native = Handoff.isNativeTargetMapping(mapping)
      const adopting = Handoff.isNativeTargetMapping(mapping) && mapping.target.kind === "existing"
      if (!adopting && (record.difference || record.differenceConsent || record.differenceActor))
        invalid("Only an existing native directory can carry a target difference")
      if (
        !native &&
        !record.request.environmentMapping &&
        (record.targetActor ||
          record.difference ||
          record.differenceConsent ||
          record.differenceActor ||
          record.previewReleased ||
          record.sourceBinding ||
          record.sourceControlRevision !== undefined)
      )
        invalid("Native target facts require their explicit native mapping")
      if (
        native &&
        (!record.sourceBinding ||
          record.sourceControlRevision === undefined ||
          record.sourceBinding.orgID !== record.orgID ||
          record.sourceBinding.driverRuntimeID !== record.sourceRuntimeID ||
          record.sourceBinding.bindingEpoch !== record.fromEpoch)
      )
        invalid("Native cleanup requires its original canonical source binding and control revision")
      const actor = (value: ActorStamp.Info | undefined) =>
        value?.kind === "account" &&
        record.target.runtimeKind === "member" &&
        value.subjectID === record.target.accountID &&
        value.orgID === record.orgID &&
        value.requestID === record.handoffID
      if (record.targetActor && !actor(record.targetActor)) invalid("Native mapping consent has another target member")
      if (native && record.targetAccepted && !actor(record.targetActor))
        invalid("Native mapping requires its original target consent actor")
      if (mapping.kind === "native-existing" && record.workspaceSource)
        invalid("Native source capture cannot substitute a service Workspace snapshot")
      const frozen = record.frozen?.proof,
        prepared = record.prepared?.proof
      if (
        native &&
        frozen &&
        (frozen.purpose !== "source-frozen" ||
          !sourceSnapshotHash(record) ||
          frozen.workspaceSourceHash !== sourceSnapshotHash(record))
      )
        invalid("Native handoff has no complete frozen source snapshot")
      if (
        native &&
        prepared &&
        (prepared.purpose !== "target-prepared" ||
          !prepared.workspaceNativeReceiptHash ||
          (adopting
            ? !record.differenceConsent ||
              !record.difference ||
              prepared.workspaceDifferenceHash !== record.differenceConsent.diffHash
            : prepared.workspaceDifferenceHash !== undefined))
      )
        invalid("Native target preparation has no exact second consent and complete receipt")
      const difference = record.difference?.proof
      if (
        difference &&
        (bindingFields.some((field) => record[field] !== difference[field]) ||
          difference.manifestHash !== record.manifestHash ||
          difference.difference.mappingPlanRevision !== record.mappingPlanRevision ||
          !sourceSnapshotHash(record) ||
          difference.difference.sourceSnapshotHash !== sourceSnapshotHash(record))
      )
        invalid("Native difference changed its complete frozen source binding")
      if (
        record.differenceConsent &&
        (!difference ||
          !actor(record.differenceActor) ||
          !same(record.differenceConsent, Handoff.DifferenceConsent.strip().parse(difference.difference)))
      )
        invalid("Native difference consent does not match its exact preview")
      if (record.differenceActor && !record.differenceConsent)
        invalid("Native consent actor has no accepted difference")
      const released = record.previewReleased?.proof
      if (
        released &&
        (record.prepared ||
          record.surrendered ||
          record.activated ||
          released.purpose !== "target-preview-released" ||
          bindingFields.some((field) => record[field] !== released[field]) ||
          released.manifestHash !== record.manifestHash ||
          released.diffHash !== (difference?.difference.diffHash ?? null))
      )
        invalid("Native preview release has another inactive preparation")
    })
  export const PreviousFileStored = FileStored.safeExtend({ version: z.literal(3) })
  export const Stored = FileStored.safeExtend({
    version: z.union([z.literal(4), z.literal(5)]),
    syncTransferVersion: z.literal(Handoff.syncTransferVersion).optional(),
  }).superRefine((record, context) => {
    const invalid = (message: string) => context.addIssue({ code: "custom", message })
    if ((record.version === 5) !== (record.syncTransferVersion === Handoff.syncTransferVersion))
      invalid("Handoff sync transfer must retain its explicit native closure reader")
    if (record.version === 5) {
      const frozen = record.frozen?.proof
      if (frozen && (frozen.purpose !== "source-frozen" || !frozen.syncCheckpoint))
        invalid("Sync transfer lacks its original source checkpoint")
      const prepared = record.prepared?.proof
      if (prepared && (prepared.purpose !== "target-prepared" || !prepared.syncCheckpointHash))
        invalid("Sync transfer lacks its original target checkpoint")
    }
    if (!record.request.environmentMapping) return
    if (record.request.environmentMapping.expectedSelectionRevision !== (record.workspaceContract?.revision ?? 0))
      context.addIssue({ code: "custom", message: "Environment mapping lost its original resource contract" })
    if (
      !record.selectionActor ||
      record.selectionActor.kind !== "account" ||
      record.selectionActor.subjectID !== record.initiator
    )
      context.addIssue({ code: "custom", message: "Environment mapping lost its original authenticated selector" })
    if (
      record.targetAccepted &&
      record.target.runtimeKind === "member" &&
      record.targetActor?.subjectID !== record.target.accountID
    )
      context.addIssue({ code: "custom", message: "Environment mapping has no exact destination member consent" })
  })
  export const RawStored = z.union([LegacyStored, PreviousStored, PreviousFileStored, Stored])
  export type Stored = z.infer<typeof Stored>
  export type RawStored = z.infer<typeof RawStored>
}
