import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationHandoffRecovery as Recovery,
  OrganizationHandoffObjectProtocol as Objects,
  OrganizationIdentity as Identity,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationExecutionProtocol as Execution,
  OrganizationCloudProtocol as Cloud,
  OrganizationProtocol as Organization,
} from "@ericsanchezok/synergy-organization-protocol"
import type { Credentials } from "./auth/session"
import { authorize, projectView, resourceView } from "./authorization"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { OrganizationSessionResources } from "./session-resources"
import { OrganizationSharing } from "./sharing"
import { fail, revision, OrganizationError } from "./error"
import { assertRuntimeConnection, runtimeAuthority } from "./runtime-authority"
import type { RuntimeConnections } from "./runtime-connection"
import type { CommandSigningAuthority } from "./signing"
import { AuthorityJournal } from "@ericsanchezok/synergy-harness/storage/authority-journal"
import { createHash } from "node:crypto"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { UpgradeWork } from "@ericsanchezok/synergy-harness/storage/upgrade-work"
import { OrganizationAuthorityHistory as History } from "./authority-history"
import { ActorStamp } from "@ericsanchezok/synergy-util/actor-stamp"
import { upgradeAccessRecord } from "@ericsanchezok/synergy-harness/migration/import"
import { OrganizationCloud } from "./cloud"
import { WorkspaceMove } from "@ericsanchezok/synergy-harness/workspace/move"
import { WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { listHandoffTargets } from "./handoff-discovery"
import { WorkspaceArchive } from "@ericsanchezok/synergy-harness/workspace/archive"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { OrganizationResources } from "./resources"

function wholeWorkspace(mapping: Handoff.WorkspaceMapping) {
  return (
    (mapping.kind === "organization-live" || mapping.kind === "organization-native") && mapping.resource.path === ""
  )
}

const LegacyStored = Handoff.LegacyView.omit({
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
const selection = (record: z.infer<typeof MappedStored>) =>
  record.request.workspaceMapping.kind === "native" ||
  (record.selectionActor?.kind === "account" &&
    record.selectionActor.subjectID === record.initiator &&
    record.selectionActor.orgID === record.orgID &&
    record.selectionActor.requestID === record.handoffID)
const PreviousStored = MappedStored.extend({ version: z.literal(2) }).refine(
  (record) => record.request.workspaceMapping.kind !== "organization-native" && selection(record),
  "Version-two handoffs require their original mapping reader",
)
const Stored = MappedStored.extend({
  version: z.literal(3),
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
    const native = mapping.kind === "organization-native"
    const adopting = mapping.kind === "organization-native" && mapping.target.kind === "existing"
    if (!adopting && (record.difference || record.differenceConsent || record.differenceActor))
      invalid("Only an existing native directory can carry a target difference")
    if (
      !native &&
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
    const frozen = record.frozen?.proof,
      prepared = record.prepared?.proof
    if (
      native &&
      frozen &&
      (frozen.purpose !== "source-frozen" ||
        !record.workspaceSource ||
        frozen.workspaceSourceHash !== WorkspaceArchive.subtreeHash(record.workspaceSource))
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
        !record.workspaceSource ||
        difference.difference.sourceSnapshotHash !== WorkspaceArchive.subtreeHash(record.workspaceSource))
    )
      invalid("Native difference changed its complete frozen source binding")
    if (
      record.differenceConsent &&
      (!difference ||
        !actor(record.differenceActor) ||
        !same(record.differenceConsent, Handoff.DifferenceConsent.strip().parse(difference.difference)))
    )
      invalid("Native difference consent does not match its exact preview")
    if (record.differenceActor && !record.differenceConsent) invalid("Native consent actor has no accepted difference")
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
const RawStored = z.union([LegacyStored, PreviousStored, Stored])
type Stored = z.infer<typeof Stored>
const key = (id: string) => ["organization", "handoffs", id]
const sessionKey = (sessionID: string) => ["organization", "session-handoffs", sessionID]
const cleanupRoot = ["organization", "handoff-targets"]
const CleanupEntry = z.strictObject({ version: z.literal(1), handoffID: Identity.ID })
const participantHash = (publicKey: string) => createHash("sha256").update(publicKey).digest("hex")
const cleanupPrefix = (runtimeID: string, publicKey: string) => [...cleanupRoot, runtimeID, participantHash(publicKey)]
async function indexCleanup(record: Stored) {
  if (!Storage.inWriteTransaction())
    fail("INVALID_REQUEST", "Handoff participant index must join its canonical transaction")
  if (record.target.runtimeKind !== "member") return
  const key = [...cleanupPrefix(record.targetRuntimeID, record.target.publicKey), record.handoffID]
  const [existing] = await Storage.readMany([key])
  if (existing !== undefined && CleanupEntry.parse(existing).handoffID !== record.handoffID)
    fail("SERVICE_UNAVAILABLE", "Handoff participant index conflicts with its original record")
  await Storage.write(key, CleanupEntry.parse({ version: 1, handoffID: record.handoffID }))
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
interface WorkspaceFrame {
  scopeID: string
  request?: WorkspaceMove.Request
  source?: Extract<Handoff.WorkspaceMapping, { kind: "organization-live" }>["resource"]
  snapshot(): Promise<WorkspaceArchive.Subtree | undefined>
  retain(snapshot: WorkspaceArchive.Subtree): Promise<WorkspaceArchive.Subtree>
  proof: Cloud.HandoffWorkspaceProof
  assert(): void
  recheck(): Promise<void>
}
const workspaceFrames = new WeakMap<OrganizationHandoffExecution.WorkspaceAuthority, WorkspaceFrame>()
function publicRuntime(record: Record.RuntimeRegistration) {
  const { schemaVersion: _, ...value } = record
  return Runtime.Registration.parse(value)
}
function workspaceRequest(record: Stored, projectID: string) {
  const mapping = record.request.workspaceMapping
  if (mapping.kind !== "organization-object") return
  if (!record.selectionActor) fail("HANDOFF_BLOCKED", "Workspace mapping has no original authenticated selector")
  return WorkspaceMove.Request.parse({
    id: mapping.moveID,
    source: { ...mapping.source, scopeID: projectID },
    target: {
      workspaceID: mapping.target.workspaceID,
      generation: mapping.target.generation,
      path: mapping.target.path,
      expectedRevision: mapping.target.expectedRevision,
      scopeID: OrganizationCloud.scopeID(record.orgID, projectID),
    },
    mappingRevision: record.mappingPlanRevision,
    acceptedDiffHash: mapping.acceptedDiffHash,
    actor: record.selectionActor,
  })
}
async function workspaceReleaseRequest(record: Stored) {
  const mapping = record.request.workspaceMapping
  if (mapping.kind !== "organization-object") return
  const [target] = await WorkspaceCatalog.readMany([mapping.target.workspaceID])
  if (!target) fail("SERVICE_UNAVAILABLE", "Original Workspace move target metadata is unavailable")
  const retained = await WorkspaceMove.requestForTarget({
    id: mapping.moveID,
    workspaceID: mapping.target.workspaceID,
    scopeID: target.scopeID,
  })
  if (!retained) fail("SERVICE_UNAVAILABLE", "Original Workspace move request is unavailable")
  const request = workspaceRequest(record, retained.source.scopeID)
  if (!request || !same(request, retained))
    fail("PROTOCOL_MISMATCH", "Workspace release changed its original complete request")
  return request
}
const bindingFields = [
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

export function registerHandoffAuthorityHistory() {
  AuthorityJournal.register({
    id: "organization-handoff-authority",
    version: 1,
    prefixes: [["organization", "handoffs"]],
    project(_key, value) {
      const record = RawStored.parse(value)
      return {
        handoffID: record.handoffID,
        sessionID: record.sessionID,
        orgID: record.orgID,
        deploymentIncarnation: record.deploymentIncarnation,
        phase: record.phase,
        initiator: record.initiator,
        sourceRuntimeID: record.sourceRuntimeID,
        targetRuntimeID: record.targetRuntimeID,
        fromEpoch: record.fromEpoch,
        toEpoch: record.toEpoch,
        mappingPlanRevision: record.mappingPlanRevision,
        targetAccepted: record.targetAccepted,
        cancelRequested: record.cancelRequested,
        factsHash: createHash("sha256")
          .update(
            JSON.stringify([
              record.request,
              ...("selectionActor" in record ? [record.selectionActor] : []),
              ...("workspaceContract" in record && record.workspaceContract ? [record.workspaceContract] : []),
              ...("workspaceSource" in record && record.workspaceSource ? [record.workspaceSource] : []),
              ...(record.version === 3 && record.targetActor ? [record.targetActor] : []),
              ...(record.version === 3 && record.difference ? [record.difference] : []),
              ...(record.version === 3 && record.differenceConsent
                ? [record.differenceConsent, record.differenceActor]
                : []),
              ...(record.version === 3 && record.previewReleased ? [record.previewReleased] : []),
              ...(record.version === 3 && record.sourceBinding
                ? [record.sourceBinding, record.sourceControlRevision]
                : []),
              record.frozen,
              record.prepared,
              record.surrendered,
              record.cancelled,
              record.activated,
              record.retired,
              record.surrenderPermit,
              record.activationPermit,
            ]),
          )
          .digest("hex"),
      }
    },
  })
}

export namespace OrganizationHandoffExecution {
  export interface WorkspaceAuthority {
    readonly kind: "handoff-workspace-authority"
  }
  export function workspaceAuthority(value: WorkspaceAuthority) {
    const frame = workspaceFrames.get(value)
    if (!frame) fail("PERMISSION_DENIED", "Workspace moves require their original handoff authority")
    frame.assert()
    return {
      scopeID: frame.scopeID,
      request: frame.request && WorkspaceMove.Request.parse(frame.request),
      source: frame.source && structuredClone(frame.source),
      snapshot: frame.snapshot,
      retain: frame.retain,
      proof: Cloud.HandoffWorkspaceProof.parse(frame.proof),
      assert: frame.assert,
      recheck: frame.recheck,
    }
  }
  const root = ["organization", "session-handoff-epochs"]
  const Entry = z.strictObject({ version: z.literal(1), handoffID: Identity.ID })
  const epochKey = (sessionID: string, epoch: number) => [
    ...root,
    Identity.ID.parse(sessionID),
    String(epoch).padStart(16, "0"),
  ]
  export async function index(value: Stored) {
    if (!Storage.inWriteTransaction()) fail("INVALID_REQUEST", "Handoff epoch index must join its canonical writer")
    const record = Stored.parse(value)
    const key = epochKey(record.sessionID, record.toEpoch)
    const [existing] = await Storage.readMany([key])
    if (existing !== undefined && Entry.parse(existing).handoffID !== record.handoffID)
      fail("SERVICE_UNAVAILABLE", "Handoff epoch index conflicts with canonical reservation history")
    await Storage.write(key, Entry.parse({ version: 1, handoffID: record.handoffID }))
  }
  export async function assertExecution(session: Record.SessionDirectory, grant: Execution.Grant) {
    if (!Storage.inTransaction()) fail("INVALID_REQUEST", "Execution eligibility must join its canonical snapshot")
    if (session.handoffID) fail("HANDOFF_BLOCKED", "Session handoff blocks resource execution")
    if (session.nextBindingEpoch === session.bindingEpoch + 1) return
    const [raw] = await Storage.readMany([epochKey(session.sessionID, session.nextBindingEpoch - 1)])
    if (raw === undefined) fail("HANDOFF_BLOCKED", "Handoff epoch index requires its owning migration")
    const entry = Entry.parse(raw)
    const [value] = await Storage.readMany([key(entry.handoffID)])
    const record = Stored.parse(upgradeAccessRecord(key(entry.handoffID), value))
    const cancelled = record.cancelled?.proof
    if (
      record.handoffID !== entry.handoffID ||
      record.sessionID !== session.sessionID ||
      record.orgID !== session.orgID ||
      record.deploymentIncarnation !== grant.deploymentIncarnation ||
      record.sourceRuntimeID !== session.driverRuntimeID ||
      record.fromEpoch !== session.bindingEpoch ||
      record.toEpoch !== session.nextBindingEpoch - 1 ||
      record.phase !== "cancelled" ||
      !record.cancelRequested ||
      cancelled?.purpose !== "source-cancelled" ||
      cancelled.handoffID !== record.handoffID ||
      cancelled.sessionID !== session.sessionID ||
      cancelled.sourceRuntimeID !== record.sourceRuntimeID ||
      cancelled.targetRuntimeID !== record.targetRuntimeID ||
      cancelled.fromEpoch !== record.fromEpoch ||
      cancelled.toEpoch !== record.toEpoch
    )
      fail("HANDOFF_BLOCKED", "Execution requires the exact permanent source cancellation outcome")
    if (
      !record.cancelled ||
      record.source.runtimeID !== record.sourceRuntimeID ||
      !(await Handoff.verifyProof(cancelled, record.cancelled.signature, record.source.publicKey))
    )
      fail("HANDOFF_BLOCKED", "Execution cancellation outcome has invalid native source evidence")
    const request = await Record.read(
      Record.CommandRequest,
      Keys.commandRequest(grant.actor.subjectID, grant.actor.requestID),
    )
    const accepted = request?.accepted
    if (
      !accepted ||
      accepted.effect.kind !== "inbox" ||
      accepted.effect.mode !== "task" ||
      accepted.permit.orgID !== grant.orgID ||
      accepted.permit.sessionID !== grant.sessionID ||
      accepted.permit.projectID !== grant.projectID ||
      accepted.permit.admissionID !== grant.admissionID ||
      accepted.permit.attemptID !== grant.attemptID ||
      !same(accepted.permit.actor, grant.actor) ||
      accepted.permit.provisionalGrantID !== (grant.provenance?.originGrantID ?? grant.grantID) ||
      (grant.state === "bound" && accepted.effect.messageID !== grant.rootID)
    )
      fail("PROTOCOL_MISMATCH", "Execution lacks its canonical original task reception")
    const control = grant.provenance?.control
    if (control) {
      const current = await Record.read(
        Record.CommandRequest,
        Keys.commandRequest(control.permit.actor.subjectID, control.permit.requestID),
      )
      if (
        !same(current?.accepted, control) ||
        control.effect.operation !== "continue" ||
        control.effect.rootID !== accepted.effect.messageID
      )
        fail("PERMISSION_DENIED", "Execution lacks its canonical independent control")
    }
    const authority = control?.permit ?? accepted.permit
    if (
      authority.runtimeID !== session.driverRuntimeID ||
      authority.bindingEpoch !== session.bindingEpoch ||
      authority.commandSeq <= record.commandSeq
    )
      fail(
        "HANDOFF_BLOCKED",
        "Source cancellation requires an independently accepted control or new task after its exact barrier",
      )
  }
  export const workspaceMigration: Migration = {
    id: "20261112-organization-handoff-workspace-mapping",
    description: "Retain explicit native semantics for version-one Workspace handoffs",
    scope: "global",
    execution: "record",
    async up() {},
    upgradeRecord(key, record) {
      if (key.length !== 3 || key[0] !== "organization" || key[1] !== "handoffs" || record.version !== 1) return
      const legacy = LegacyStored.parse(record)
      record.version = 2
      record.request = { ...legacy.request, workspaceMapping: { kind: "native" } }
      record.selectionActor = null
      PreviousStored.parse(record)
    },
  }
  export const differenceMigration: Migration = {
    id: "20261113-organization-handoff-native-difference",
    description: "Retain native target consent and inactive preparation facts in the owning Handoff reader",
    scope: "global",
    execution: "record",
    dependsOn: ["organization/20261112-organization-handoff-workspace-mapping"],
    async up() {},
    upgradeRecord(key, value) {
      if (key.length !== 3 || key[0] !== "organization" || key[1] !== "handoffs" || value.version !== 2) return
      PreviousStored.parse(value)
      value.version = 3
      Stored.parse(value)
    },
  }
  export const cleanupMigration: Migration = {
    id: "20261113-organization-handoff-cleanup-participant-index",
    description: "Index original target participant identities without separate cleanup state",
    scope: "global",
    execution: "startup",
    dependsOn: ["organization/20261113-organization-handoff-native-difference"],
    async up(progress) {
      await Storage.removeTree(cleanupRoot)
      let count = 0
      for await (const row of Storage.records({ prefix: ["organization", "handoffs"], limit: 128 })) {
        UpgradeWork.signal()?.throwIfAborted()
        const record = Stored.parse(upgradeAccessRecord(row.key, row.value))
        if (row.key.length !== 3 || row.key[2] !== record.handoffID)
          fail("SERVICE_UNAVAILABLE", "Handoff participant index has another canonical record")
        await Storage.transaction(() => indexCleanup(record))
        progress(++count, 0)
      }
      progress(count, count)
    },
  }
  export const migration: Migration = {
    id: "20261112-organization-handoff-epoch-index",
    description: "Index canonical reserved handoff epochs for execution fences",
    scope: "global",
    execution: "startup",
    dependsOn: ["20261108-organization-deployment"],
    async up(progress) {
      await Storage.removeTree(root)
      let count = 0
      for await (const row of Storage.records({ prefix: ["organization", "handoffs"], limit: 128 })) {
        UpgradeWork.signal()?.throwIfAborted()
        const record = Stored.parse(upgradeAccessRecord(row.key, row.value))
        if (row.key.length !== 3 || row.key[2] !== record.handoffID)
          fail("SERVICE_UNAVAILABLE", "Handoff history has another canonical key")
        await Storage.transaction(() => index(record))
        progress(++count, 0)
      }
      progress(count, count)
    },
  }
}

export function createHandoffs(options: {
  connections: RuntimeConnections
  signing: CommandSigningAuthority
  timeoutMs?: number
}) {
  const timeoutMs = z
    .number()
    .int()
    .min(1)
    .max(30_000)
    .parse(options.timeoutMs ?? 5000)
  let inspections = 0

  async function sourceAccess(credentials: Credentials, sessionID: string) {
    const access = await authorize(credentials, "session.read", { sessionID })
    await authorize(credentials, "project.execute", { projectID: access.session.projectID })
    const current = access.session
    if (current.handoffID) fail("HANDOFF_BLOCKED", "The current handoff already owns this Session")
    const source = await Record.read(Record.RuntimeRegistration, Keys.runtime(current.driverRuntimeID))
    if (
      !source ||
      source.orgID !== current.orgID ||
      source.deploymentIncarnation !== options.signing.identity.deploymentIncarnation ||
      source.state !== "active"
    )
      fail("HANDOFF_BLOCKED", "The current handoff source is unavailable")
    if (access.account.accountID !== (source.runtimeKind === "member" ? source.accountID : current.creatorID))
      fail("PERMISSION_DENIED", "Only the current execution owner can inspect its handoff choices")
    return { ...access, source }
  }
  async function inspectionAccess(credentials: Credentials, sessionID: string, targetRuntimeID: string) {
    const access = await sourceAccess(credentials, sessionID)
    const { source, session: current } = access
    const target = await Record.read(Record.RuntimeRegistration, Keys.runtime(targetRuntimeID))
    if (!target || target.orgID !== current.orgID || source.runtimeID === target.runtimeID)
      fail("NOT_FOUND", "Handoff destination is unavailable")
    if (target.runtimeKind === "member" && target.accountID !== current.creatorID && current.shareState !== "shared")
      fail("HANDOFF_BLOCKED", "Share this Session before handing it to another member")
    for (const runtime of [source, target]) {
      if (runtime.runtimeKind === "member") await accountExecution(runtime.accountID, current)
      const connection = options.connections.captureHandoff(runtime.runtimeID)
      if (connection.handshake.schemas.handoffs < 4)
        fail("HANDOFF_BLOCKED", "Both Runtimes must support exact handoff inspection")
      const authority = await runtimeAuthority({
        runtimeID: runtime.runtimeID,
        orgID: current.orgID,
        deploymentIncarnation: options.signing.identity.deploymentIncarnation,
        connectionEpoch: connection.handshake.connectionEpoch,
      })
      assertRuntimeConnection(authority.runtime, connection.handshake)
      if (authority.runtime.publicKey !== runtime.publicKey)
        fail("PERMISSION_DENIED", "Handoff machine identity changed")
      connection.assertCurrent()
    }
    return { ...access, source, target }
  }
  async function nativeTargetAccess(credentials: Credentials, handoffID: string) {
    const record = await load(handoffID)
    const access = await authorize(credentials, "session.read", { sessionID: record.sessionID })
    await authorize(credentials, "project.execute", { projectID: access.session.projectID })
    const current = access.session
    const mapping = record.request.workspaceMapping
    if (
      mapping.kind !== "organization-native" ||
      mapping.target.kind !== "existing" ||
      record.target.runtimeKind !== "member" ||
      !["preparing", "prepared"].includes(record.phase) ||
      record.cancelRequested ||
      current.handoffID !== record.handoffID ||
      current.driverRuntimeID !== record.sourceRuntimeID ||
      current.bindingEpoch !== record.fromEpoch ||
      current.shareGeneration !== record.shareGeneration
    )
      fail("HANDOFF_BLOCKED", "The original native destination is unavailable in this handoff phase")
    if (access.account.accountID !== record.target.accountID)
      fail("PERMISSION_DENIED", "Only the original destination member can inspect its native directory")
    const connection = options.connections.captureHandoff(record.targetRuntimeID)
    if (connection.handshake.schemas.handoffs < 4)
      fail("HANDOFF_BLOCKED", "The destination does not support exact directory inspection")
    const authority = await runtimeAuthority({
      runtimeID: record.targetRuntimeID,
      orgID: record.orgID,
      deploymentIncarnation: record.deploymentIncarnation,
      connectionEpoch: connection.handshake.connectionEpoch,
    })
    const runtime = authority.runtime
    if (
      runtime.runtimeKind !== "member" ||
      runtime.accountID !== record.target.accountID ||
      runtime.deviceID !== record.target.deviceID ||
      runtime.publicKey !== record.target.publicKey
    )
      fail("PERMISSION_DENIED", "The original native destination identity changed")
    assertRuntimeConnection(runtime, connection.handshake)
    connection.assertCurrent()
    return { ...access, record, mapping, connection }
  }
  async function load(id: string) {
    const [value] = await Storage.readMany([key(Identity.ID.parse(id))])
    if (!value) fail("NOT_FOUND", "Handoff not found")
    const record = Stored.parse(upgradeAccessRecord(key(id), value))
    if (
      record.handoffID !== id ||
      record.orgID !== options.signing.identity.orgID ||
      record.deploymentIncarnation !== options.signing.identity.deploymentIncarnation
    )
      fail("PROTOCOL_MISMATCH", "Handoff identity is inconsistent")
    return record
  }

  async function session(record: Stored) {
    const current = await Record.read(Record.SessionDirectory, Keys.session(record.sessionID))
    if (!current || current.orgID !== record.orgID) fail("NOT_FOUND", "Session not found")
    return current
  }

  async function view(record: Stored, accountID?: string): Promise<Handoff.View> {
    const current = await session(record)
    const missingRequirements: z.infer<typeof Handoff.Requirement>[] = []
    if (!record.targetAccepted)
      missingRequirements.push({
        code: "target_consent",
        label: "The destination member must accept the current mapping plan",
        recoverable: true,
      })
    if (!record.frozen && !["cancelled", "retired"].includes(record.phase))
      missingRequirements.push({
        code: "source_freeze",
        label: "Waiting for the source command barrier, pause and writer drainage proof",
        recoverable: true,
      })
    if (!record.prepared && !["cancelled", "retired"].includes(record.phase))
      missingRequirements.push({
        code: "target_prepare",
        label: "Waiting for verified destination staging and complete dependencies",
        recoverable: true,
      })
    return Handoff.View.strip().parse({
      ...record,
      workspaceMapping: record.request.workspaceMapping,
      mappingHash: await Handoff.mappingHash(record.request.workspaceMapping),
      workspaceDifference: record.difference?.proof.difference,
      ...(record.request.workspaceMapping.kind === "organization-native" &&
      record.request.workspaceMapping.target.kind === "existing"
        ? { workspaceDifferenceAccepted: !!record.differenceConsent }
        : {}),
      missingRequirements,
      canCancel:
        !record.surrendered &&
        !["completed", "cancelled", "retired"].includes(record.phase) &&
        (!accountID || accountID === record.initiator),
      canAccept:
        record.phase === "preparing" &&
        (!record.targetAccepted || (!!record.difference && !record.differenceConsent)) &&
        record.target.runtimeKind === "member" &&
        (!accountID || accountID === record.target.accountID),
      canContinue: record.phase === "completed" && !current.handoffID,
      currentDriver: current.driverRuntimeID,
      bindingEpoch: current.bindingEpoch,
    })
  }

  async function accountExecution(accountID: string, current: Record.SessionDirectory) {
    const account = await Record.read(Record.Account, Keys.account(accountID))
    const project = await Record.read(Record.Project, Keys.project(current.projectID))
    const membership = await Record.read(Record.ProjectMember, Keys.projectMember(current.projectID, accountID))
    if (!account || !project || account.orgID !== current.orgID)
      fail("PERMISSION_DENIED", "Handoff account is unavailable")
    const view = projectView(account, project, membership, "project.execute")
    return { account, view }
  }

  async function eligible(record: Stored) {
    const current = await session(record)
    if (current.handoffID !== record.handoffID || current.shareGeneration !== record.shareGeneration)
      fail("HANDOFF_BLOCKED", "Session handoff ownership or sharing generation changed")
    const committed = ["committed", "activation_permitted", "completed", "retired"].includes(record.phase)
    if (
      current.driverRuntimeID !== (committed ? record.targetRuntimeID : record.sourceRuntimeID) ||
      current.bindingEpoch !== (committed ? record.toEpoch : record.fromEpoch)
    )
      fail("HANDOFF_BLOCKED", "Session execution binding changed")
    const sourceLease = record.surrendered ? undefined : options.connections.capture(record.sourceRuntimeID)
    const targetLease = options.connections.capture(record.targetRuntimeID)
    for (const [expected, lease] of [
      [record.source, sourceLease],
      [record.target, targetLease],
    ] as const) {
      const latest = await Record.read(Record.RuntimeRegistration, Keys.runtime(expected.runtimeID))
      if (!latest) fail("PERMISSION_DENIED", "Handoff machine is unavailable")
      const authority = await runtimeAuthority({
        runtimeID: expected.runtimeID,
        orgID: expected.orgID,
        deploymentIncarnation: expected.deploymentIncarnation,
        connectionEpoch: lease?.handshake.connectionEpoch ?? latest.connectionEpoch,
      })
      if (lease) assertRuntimeConnection(authority.runtime, lease.handshake)
      if (authority.runtime.publicKey !== expected.publicKey)
        fail("PERMISSION_DENIED", "Handoff machine identity changed")
      if (expected.runtimeKind === "member") await accountExecution(expected.accountID, current)
    }
    await accountExecution(record.initiator, current)
    if (
      record.target.runtimeKind === "member" &&
      record.target.accountID !== current.creatorID &&
      current.shareState !== "shared"
    )
      fail("HANDOFF_BLOCKED", "A different member can receive only a shared Session")
    if (!record.targetAccepted) fail("HANDOFF_BLOCKED", "The destination member has not accepted this mapping plan")
    const contract = await OrganizationSessionResources.read(current)
    if (contract?.selection) await OrganizationSessionResources.enabled(current, contract.selection)
    const mapping = record.request.workspaceMapping
    if (
      mapping.kind === "organization-native" &&
      mapping.target.kind === "private-copy" &&
      contract?.selection?.infrastructure.environment
    )
      fail("HANDOFF_BLOCKED", "Downloading a native Workspace requires an explicit compatible Environment mapping")
    if (mapping.kind === "organization-object") {
      const resource = await Record.read(Record.Resource, Keys.resource(record.orgID, mapping.target.resourceID))
      if (
        !resource ||
        resource.orgID !== record.orgID ||
        resource.resourceID !== mapping.target.resourceID ||
        resource.state !== "enabled" ||
        resource.configuration.protocol !== "workspace-storage" ||
        (resource.scope.kind === "project" && resource.scope.projectID !== current.projectID)
      )
        fail("RESOURCE_UNAVAILABLE", "The mapped Workspace storage resource is unavailable")
      const selector = record.selectionActor
      if (selector?.kind !== "account") fail("PERMISSION_DENIED", "Workspace mapping has no authenticated selector")
      const { account, view } = await accountExecution(selector.subjectID, current)
      const [personal, shared] = await Promise.all([
        Record.read(
          Record.ResourceGrant,
          Keys.resourceGrant(record.orgID, resource.resourceID, { kind: "account", id: selector.subjectID }),
        ),
        Record.read(
          Record.ResourceGrant,
          Keys.resourceGrant(record.orgID, resource.resourceID, { kind: "project", id: current.projectID }),
        ),
      ])
      if (!resourceView(account, resource, view, personal, shared).permissions.use)
        fail("PERMISSION_DENIED", "The original Workspace selector cannot use its mapped storage resource")
      await OrganizationCloud.assertInfrastructure(record.orgID, current.projectID, {
        workspace: { resourceID: mapping.target.resourceID, workspaceID: mapping.target.workspaceID },
        environment: null,
      })
    } else if (mapping.kind === "organization-live" || mapping.kind === "organization-native") {
      const selected = contract?.selection?.infrastructure.workspace
      if (
        (!committed || mapping.kind !== "organization-native") &&
        (!selected ||
          selected.resourceID !== mapping.resource.resourceID ||
          selected.workspaceID !== mapping.resource.workspaceID)
      )
        fail("PROTOCOL_MISMATCH", "Live handoff must retain the Session's original Workspace resource")
      const catalog = await WorkspaceCatalog.get(
        mapping.resource.workspaceID,
        OrganizationCloud.scopeID(record.orgID, current.projectID),
      )
      if (catalog.activeMount || catalog.binding.generation !== mapping.resource.generation)
        fail("RESOURCE_UNAVAILABLE", "Live handoff requires its current dormant Workspace generation")
      if (
        mapping.kind === "organization-native" &&
        record.workspaceSource &&
        (catalog.revision !== record.workspaceSource.revision ||
          (catalog.content?.manifest ?? null) !== record.workspaceSource.head)
      )
        fail("REVISION_CONFLICT", "Native adoption requires the unchanged final service Workspace snapshot")
    }
    return {
      current,
      guard() {
        sourceLease?.assertCurrent()
        targetLease.assertCurrent()
      },
    }
  }

  async function initiator(credentials: Credentials, record: Stored) {
    const access = await authorize(credentials, "session.read", { sessionID: record.sessionID })
    await authorize(credentials, "project.execute", { projectID: access.session.projectID })
    if (access.account.accountID !== record.initiator)
      fail("PERMISSION_DENIED", "Only the current execution owner can initiate this handoff")
    return access
  }

  async function originalCleanup(record: Stored) {
    const proof = record.cancelled?.proof
    if (
      record.phase !== "cancelled" ||
      record.request.workspaceMapping.kind !== "organization-native" ||
      !record.sourceBinding ||
      record.sourceControlRevision === undefined ||
      !record.frozen ||
      !record.manifestHash ||
      record.surrendered ||
      record.activated ||
      proof?.purpose !== "source-cancelled" ||
      bindingFields.some((field) => record[field] !== proof[field]) ||
      proof.manifestHash !== record.manifestHash ||
      !record.cancelled ||
      !(await Handoff.verifyProof(proof, record.cancelled.signature, record.source.publicKey))
    )
      fail("HANDOFF_BLOCKED", "Native cleanup requires the exact permanent source cancellation proof")
    return {
      sourceBinding: record.sourceBinding,
      controlRevision: record.sourceControlRevision,
      manifestHash: record.manifestHash,
      frozen: record.frozen,
      cleanup: record.cancelled,
    }
  }
  async function cleanupPage(runtime: Record.RuntimeRegistration, value: Identity.Page): Promise<Recovery.Page> {
    const page = Identity.Page.parse(value),
      prefix = cleanupPrefix(runtime.runtimeID, runtime.publicKey)
    const rows = await Storage.query({
      prefix,
      after: page.cursor ? [...prefix, page.cursor] : undefined,
      limit: page.limit + 1,
    })
    const items: z.infer<typeof Recovery.Descriptor>[] = []
    for (const row of rows.slice(0, page.limit)) {
      const entry = CleanupEntry.parse(row.value),
        record = await load(entry.handoffID)
      if (
        row.key.length !== 5 ||
        row.key.at(-1) !== record.handoffID ||
        record.targetRuntimeID !== runtime.runtimeID ||
        record.target.publicKey !== runtime.publicKey ||
        record.orgID !== runtime.orgID ||
        record.deploymentIncarnation !== runtime.deploymentIncarnation ||
        record.target.runtimeKind !== "member" ||
        runtime.runtimeKind !== "member" ||
        record.target.accountID !== runtime.accountID ||
        record.target.deviceID !== runtime.deviceID
      )
        fail("SERVICE_UNAVAILABLE", "Handoff participant index conflicts with its original owner")
      if (
        record.phase !== "cancelled" ||
        record.request.workspaceMapping.kind !== "organization-native" ||
        !record.frozen ||
        !record.manifestHash
      )
        continue
      const original = await originalCleanup(record)
      const fact = record.retired ?? record.previewReleased
      items.push(
        Recovery.Descriptor.parse({
          ...Handoff.Binding.strip().parse(record),
          manifestHash: original.manifestHash,
          ...(fact ? { cleanupFactHash: await Handoff.proofHash(fact.proof) } : {}),
        }),
      )
    }
    return Recovery.Page.parse({
      items,
      cursor: rows.length > page.limit ? rows[page.limit - 1]!.key.at(-1) : undefined,
    })
  }
  async function machineAccess(credentials: Credentials, record: Stored, operation: Handoff.MachineOperation) {
    if (
      (operation === "retire-target" || operation === "inspect-target") &&
      record.phase === "cancelled" &&
      record.request.workspaceMapping.kind === "organization-native"
    ) {
      const access = await authorize(credentials, "runtime.read", { runtimeID: record.targetRuntimeID })
      if (
        record.target.runtimeKind !== "member" ||
        access.account.accountID !== record.target.accountID ||
        access.runtime.runtimeKind !== "member" ||
        access.runtime.accountID !== access.account.accountID ||
        access.runtime.runtimeID !== record.targetRuntimeID ||
        access.runtime.orgID !== record.orgID ||
        access.runtime.deploymentIncarnation !== record.deploymentIncarnation ||
        access.runtime.state !== "active" ||
        access.runtime.publicKey !== record.target.publicKey
      )
        fail(
          "PERMISSION_DENIED",
          "Only the original active destination member can drain its cancelled native preparation",
        )
      const original = await originalCleanup(record)
      return {
        ...access,
        sourceBinding: original.sourceBinding,
        controlRevision: original.controlRevision,
        cleanup: true as const,
      }
    }
    const access = await authorize(credentials, "session.read", { sessionID: record.sessionID })
    await authorize(credentials, "project.execute", { projectID: access.session.projectID })
    return {
      ...access,
      sourceBinding: Organization.SessionBinding.parse({
        schemaVersion: 1,
        orgID: record.orgID,
        projectID: access.session.projectID,
        creatorID: access.session.creatorID,
        driverRuntimeID: record.sourceRuntimeID,
        bindingEpoch: record.fromEpoch,
      }),
      controlRevision: access.session.controlRevision,
      cleanup: false as const,
    }
  }

  async function save(record: Stored) {
    await Storage.write(key(record.handoffID), Stored.parse(record))
    await indexCleanup(record)
  }

  async function objectAuthority(request: Objects.Request) {
    const proof = request.proof
    if (proof.issuedAt > Date.now() || proof.expiresAt <= Date.now())
      fail("PERMISSION_DENIED", "Handoff object request is outside its finite authorization window")
    const record = await load(proof.handoffID)
    if (bindingFields.some((field) => record[field] !== proof[field]))
      fail("PERMISSION_DENIED", "Handoff object request belongs to another source or destination")
    if (
      record.cancelRequested ||
      !record.frozen ||
      record.manifestHash !== proof.manifestHash ||
      ["cancelled", "completed", "retired"].includes(record.phase)
    )
      fail("HANDOFF_BLOCKED", "Handoff has no currently authorized frozen package")
    const access = await eligible(record)
    const target = options.connections.captureHandoff(record.targetRuntimeID)
    const authority = await runtimeAuthority(proof)
    assertRuntimeConnection(authority.runtime, target.handshake)
    if (
      authority.runtime.publicKey !== record.target.publicKey ||
      !(await Objects.verify(proof, request.signature, authority.runtime.publicKey))
    )
      fail("PERMISSION_DENIED", "Handoff destination signature is invalid")
    const source = options.connections.captureHandoff(record.sourceRuntimeID)
    const sourceAuthority = await runtimeAuthority({
      ...proof,
      runtimeID: record.sourceRuntimeID,
      connectionEpoch: source.handshake.connectionEpoch,
    })
    assertRuntimeConnection(sourceAuthority.runtime, source.handshake)
    if (sourceAuthority.runtime.publicKey !== record.source.publicKey)
      fail("PERMISSION_DENIED", "Handoff source identity changed")
    access.guard()
    target.assertCurrent()
    source.assertCurrent()
    return { record, current: access.current, source, target, account: authority.account }
  }

  const api = {
    async nativeTarget(
      credentials: Credentials,
      handoffID: string,
      value: z.infer<typeof Handoff.NativeTargetQuery>,
      input: { signal: AbortSignal },
    ): Promise<Handoff.NativeTargetSelection> {
      credentials = { ...credentials }
      const query = Handoff.NativeTargetQuery.parse(value)
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)])
      if (inspections >= 32) fail("SERVICE_UNAVAILABLE", "Handoff inspection capacity is currently busy")
      inspections++
      try {
        const admitted = await Storage.snapshot(async () => {
          signal.throwIfAborted()
          const access = await nativeTargetAccess(credentials, Identity.ID.parse(handoffID))
          const issuedAt = Date.now()
          const expiresAt = Math.min(issuedAt + timeoutMs, access.expiresAt)
          if (expiresAt <= issuedAt) fail("AUTHENTICATION_REQUIRED", "Directory inspection authorization expired")
          const authorization = await options.signing.signHandoffInspection(
            Handoff.InspectionPlan.parse({
              schemaVersion: 1,
              purpose: "handoff-inspection",
              requestID: query.requestID,
              keyID: options.signing.identity.keyID,
              orgID: access.record.orgID,
              deploymentIncarnation: access.record.deploymentIncarnation,
              projectID: access.session.projectID,
              sessionID: access.record.sessionID,
              sourceRuntimeID: access.record.sourceRuntimeID,
              targetRuntimeID: access.record.targetRuntimeID,
              runtimeID: access.record.targetRuntimeID,
              connectionEpoch: access.connection.handshake.connectionEpoch,
              bindingEpoch: access.record.fromEpoch,
              controlRevision: access.session.controlRevision,
              role: "target",
              actor: {
                kind: "account",
                orgID: access.account.orgID,
                subjectID: access.account.accountID,
                displayName: access.account.displayName,
                clientKind: access.clientKind,
                requestID: query.requestID,
                ...("tokenID" in access ? { tokenID: access.tokenID } : {}),
              },
              issuedAt,
              expiresAt,
            }),
          )
          const mappingHash = await Handoff.mappingHash(access.mapping)
          access.connection.assertCurrent()
          return { access, authorization, mappingHash }
        })
        const reply = await admitted.access.connection.exchange(
          { kind: "handoff-inspection", authorization: admitted.authorization },
          { signal, deadline: admitted.authorization.plan.expiresAt },
        )
        signal.throwIfAborted()
        admitted.access.connection.assertCurrent()
        if (reply.kind === "error") throw new OrganizationError(reply.error)
        if (
          reply.kind !== "handoff-inspection" ||
          !Handoff.matchesInspection(admitted.authorization.plan, reply.result)
        )
          fail("PROTOCOL_MISMATCH", "Directory inspection returned another original participant")
        const native = reply.result.native
        const expected = admitted.access.mapping.target
        if (expected.kind !== "existing") fail("HANDOFF_BLOCKED", "This native mapping has no existing directory")
        if (!native) fail("RESOURCE_UNAVAILABLE", "The original native directory is unavailable")
        if (
          native.reference.workspaceID !== expected.workspaceID ||
          native.reference.generation !== expected.generation ||
          native.reference.revision !== expected.expectedRevision ||
          native.projectRevision !== expected.projectRevision
        )
          fail("REVISION_CONFLICT", "The original native directory selection changed")
        return await Storage.snapshot(async () => {
          signal.throwIfAborted()
          const current = await nativeTargetAccess(credentials, handoffID)
          const original = admitted.access
          if (
            current.session.controlRevision !== original.session.controlRevision ||
            current.account.accountID !== original.account.accountID ||
            current.record.mappingPlanRevision !== original.record.mappingPlanRevision ||
            !same(current.mapping, original.mapping) ||
            current.connection.handshake.connectionEpoch !== original.connection.handshake.connectionEpoch
          )
            fail("STALE_BINDING", "The original native destination changed during inspection")
          admitted.access.connection.assertCurrent()
          return Handoff.NativeTargetSelection.parse({
            requestID: query.requestID,
            handoffID: current.record.handoffID,
            targetRuntimeID: current.record.targetRuntimeID,
            mappingPlanRevision: current.record.mappingPlanRevision,
            mappingHash: admitted.mappingHash,
            native,
          })
        })
      } finally {
        inspections--
      }
    },
    async targets(
      credentials: Credentials,
      sessionID: string,
      value: Handoff.TargetsQuery,
      input: { signal: AbortSignal },
    ) {
      credentials = { ...credentials }
      const query = Handoff.TargetsQuery.parse(value)
      const signal = input.signal
      return Storage.snapshot(async () => {
        const assert = WorkspaceContent.captureOwner(signal)
        assert()
        const result = await listHandoffTargets(
          {
            ...(await sourceAccess(credentials, Identity.ID.parse(sessionID))),
            connections: options.connections,
            signal,
          },
          query,
        )
        assert()
        return result
      })
    },
    async cleanupCandidates(credentials: Credentials, runtimeID: string, value: Identity.Page) {
      const page = Identity.Page.parse(value)
      return Storage.snapshot(async () => {
        const access = await authorize(credentials, "runtime.read", { runtimeID })
        if (
          access.runtime.runtimeKind !== "member" ||
          access.runtime.accountID !== access.account.accountID ||
          access.runtime.state !== "active"
        )
          fail("PERMISSION_DENIED", "Only the active target member can discover its original cleanup slots")
        return cleanupPage(access.runtime, page)
      })
    },
    async recovery(value: Recovery.Request, input: { signal: AbortSignal }): Promise<Recovery.Response> {
      const request = Recovery.Request.parse(value),
        proof = request.proof,
        owner = WorkspaceContent.captureOwner(input.signal)
      return Storage.snapshot(async () => {
        owner()
        const deployment = Organization.Deployment.parse(await Storage.read(Keys.deployment()))
        const runtime = await Record.read(Record.RuntimeRegistration, Keys.runtime(proof.runtimeID))
        if (
          !runtime ||
          (proof.query.operation !== "inspect-source-receipt" && runtime.runtimeKind !== "member") ||
          runtime.state === "pending" ||
          runtime.orgID !== proof.orgID ||
          runtime.deploymentIncarnation !== proof.deploymentIncarnation ||
          deployment.orgID !== proof.orgID ||
          deployment.deploymentIncarnation !== proof.deploymentIncarnation ||
          proof.issuedAt > Date.now() ||
          proof.expiresAt <= Date.now() ||
          !(await Recovery.verify(proof, request.signature, runtime.publicKey))
        )
          fail(
            "PERMISSION_DENIED",
            "Cleanup recovery requires the original enrolled participant key and fresh deployment request",
          )
        const requestHash = await Recovery.requestHash(proof)
        const query = proof.query
        if (query.operation === "inspect-source-receipt") {
          const record = await load(query.handoffID)
          if (
            record.orgID !== proof.orgID ||
            record.deploymentIncarnation !== proof.deploymentIncarnation ||
            record.sourceRuntimeID !== runtime.runtimeID ||
            record.source.runtimeKind !== runtime.runtimeKind ||
            record.source.publicKey !== runtime.publicKey ||
            (record.source.runtimeKind === "member" &&
              (runtime.runtimeKind !== "member" ||
                record.source.accountID !== runtime.accountID ||
                record.source.deviceID !== runtime.deviceID)) ||
            (record.source.runtimeKind === "hosted" &&
              (runtime.runtimeKind !== "hosted" || record.source.createdBy !== runtime.createdBy))
          )
            fail("PERMISSION_DENIED", "Source receipt inspection belongs to another original machine")
          const issuedAt = Date.now()
          const authorization = await options.signing.signHandoffSourceReceipt(
            Recovery.SourceReceiptPermit.parse({
              ...Handoff.Binding.strip().parse(record),
              purpose: "handoff-source-receipt",
              requestID: proof.requestID,
              requestHash,
              keyID: options.signing.identity.keyID,
              runtimeID: runtime.runtimeID,
              participantKey: runtime.publicKey,
              operation: query.operation,
              cancelRequested: record.cancelRequested,
              frozen: record.frozen,
              cancelled: record.cancelled,
              surrendered: record.surrendered,
              surrenderPermit: record.surrenderPermit,
              issuedAt,
              expiresAt: Math.min(issuedAt + 30000, proof.expiresAt),
            }),
          )
          owner()
          return Recovery.Response.parse({
            requestID: proof.requestID,
            requestHash,
            signingIdentity: options.signing.identity,
            result: { operation: query.operation, authorization },
          })
        }
        if (query.operation === "discover") {
          const page = await cleanupPage(runtime, query.page)
          owner()
          if (proof.expiresAt <= Date.now()) fail("PERMISSION_DENIED", "Cleanup recovery request expired")
          return Recovery.Response.parse({
            requestID: proof.requestID,
            requestHash,
            signingIdentity: options.signing.identity,
            result: { operation: "discover", ...page },
          })
        }
        const record = await load(query.binding.handoffID)
        if (
          runtime.runtimeKind !== "member" ||
          record.targetRuntimeID !== runtime.runtimeID ||
          record.target.runtimeKind !== "member" ||
          record.target.publicKey !== runtime.publicKey ||
          record.target.accountID !== runtime.accountID ||
          record.target.deviceID !== runtime.deviceID ||
          bindingFields.some((field) => record[field] !== query.binding[field]) ||
          record.manifestHash !== query.manifestHash
        )
          fail("PERMISSION_DENIED", "Cleanup recovery belongs to another original participant or frozen binding")
        const original = await originalCleanup(record),
          issuedAt = Date.now()
        const authorization = await options.signing.signHandoffRecovery(
          Recovery.Permit.parse({
            ...Handoff.Binding.strip().parse(record),
            ...original,
            purpose: "handoff-target-cleanup",
            requestID: proof.requestID,
            requestHash,
            keyID: options.signing.identity.keyID,
            runtimeID: runtime.runtimeID,
            participantKey: runtime.publicKey,
            sourceKey: record.source.publicKey,
            operation: query.operation,
            preparedHash: record.prepared ? await Handoff.proofHash(record.prepared.proof) : undefined,
            workspacePlan: {
              mapping: record.request.workspaceMapping,
              hash: await Handoff.mappingHash(record.request.workspaceMapping),
              selectionActor: record.selectionActor,
              targetActor: record.targetActor,
              differenceConsent: record.differenceConsent,
              difference: record.difference?.proof.difference,
              targetScopeID: OrganizationCloud.scopeID(record.orgID, original.sourceBinding.projectID),
            },
            issuedAt,
            expiresAt: Math.min(issuedAt + 30000, proof.expiresAt),
          }),
        )
        owner()
        return Recovery.Response.parse({
          requestID: proof.requestID,
          requestHash,
          signingIdentity: options.signing.identity,
          result: { operation: query.operation, authorization },
        })
      })
    },
    async options(
      credentials: Credentials,
      sessionID: string,
      value: Handoff.OptionsQuery,
      input: { signal: AbortSignal },
    ): Promise<Handoff.Options> {
      credentials = { ...credentials }
      sessionID = Identity.ID.parse(sessionID)
      const request = Handoff.OptionsQuery.parse(value)
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)])
      if (inspections >= 32) fail("SERVICE_UNAVAILABLE", "Handoff inspection capacity is currently busy")
      inspections++
      try {
        const admitted = await Storage.snapshot(async () => {
          signal.throwIfAborted()
          const access = await inspectionAccess(credentials, sessionID, request.targetRuntimeID)
          const issuedAt = Date.now()
          const expiresAt = Math.min(issuedAt + timeoutMs, access.expiresAt)
          if (expiresAt <= issuedAt) fail("AUTHENTICATION_REQUIRED", "Handoff inspection authorization expired")
          const participants = await Promise.all(
            (["source", "target"] as const).map(async (role) => {
              const runtime = access[role]
              const connection = options.connections.captureHandoff(runtime.runtimeID)
              const authorization = await options.signing.signHandoffInspection(
                Handoff.InspectionPlan.parse({
                  schemaVersion: 1,
                  purpose: "handoff-inspection",
                  requestID: request.requestID,
                  keyID: options.signing.identity.keyID,
                  orgID: access.session.orgID,
                  deploymentIncarnation: options.signing.identity.deploymentIncarnation,
                  projectID: access.session.projectID,
                  sessionID,
                  sourceRuntimeID: access.source.runtimeID,
                  targetRuntimeID: access.target.runtimeID,
                  runtimeID: runtime.runtimeID,
                  connectionEpoch: connection.handshake.connectionEpoch,
                  bindingEpoch: access.session.bindingEpoch,
                  controlRevision: access.session.controlRevision,
                  role,
                  actor: {
                    kind: "account",
                    orgID: access.account.orgID,
                    subjectID: access.account.accountID,
                    displayName: access.account.displayName,
                    clientKind: access.clientKind,
                    requestID: request.requestID,
                    ...("tokenID" in access ? { tokenID: access.tokenID } : {}),
                  },
                  issuedAt,
                  expiresAt,
                }),
              )
              connection.assertCurrent()
              return { connection, authorization }
            }),
          )
          return { access, participants }
        })
        const observed = await Promise.allSettled(
          admitted.participants.map(async ({ connection, authorization }) => {
            const reply = await connection.exchange(
              { kind: "handoff-inspection", authorization },
              { signal, deadline: authorization.plan.expiresAt },
            )
            signal.throwIfAborted()
            connection.assertCurrent()
            if (reply.kind === "error") throw new OrganizationError(reply.error)
            if (reply.kind !== "handoff-inspection" || !Handoff.matchesInspection(authorization.plan, reply.result))
              fail("PROTOCOL_MISMATCH", "Handoff inspection returned another participant selection")
            return reply.result
          }),
        )
        const results = observed.map((result) => {
          if (result.status === "rejected") throw result.reason
          return result.value
        })
        return await Storage.snapshot(async () => {
          signal.throwIfAborted()
          const current = await inspectionAccess(credentials, sessionID, request.targetRuntimeID)
          const original = admitted.access
          if (
            [
              "orgID",
              "projectID",
              "driverRuntimeID",
              "bindingEpoch",
              "controlRevision",
              "shareGeneration",
              "handoffID",
            ].some(
              (field) =>
                current.session[field as keyof Record.SessionDirectory] !==
                original.session[field as keyof Record.SessionDirectory],
            ) ||
            current.account.accountID !== original.account.accountID ||
            current.source.publicKey !== original.source.publicKey ||
            current.target.publicKey !== original.target.publicKey
          )
            fail("STALE_BINDING", "Handoff choices changed during inspection")
          const source = results[0]!.workspace
          const native = results[1]!.native
          const choices: Handoff.Options["choices"] = []
          if (!source || source.kind === "native") {
            if (current.target.runtimeKind === "member") choices.push({ kind: "native", requiresDifference: false })
            let cursor: string | undefined
            do {
              const page = await OrganizationResources.available(credentials, current.session.projectID, {
                limit: 100,
                cursor,
              })
              if (
                source &&
                page.items.some(
                  (resource) =>
                    resource.state === "enabled" &&
                    resource.definition.protocol === "workspace-storage" &&
                    resource.permissions.use,
                )
              ) {
                choices.push({ kind: "organization-object", requiresDifference: false })
                break
              }
              cursor = page.cursor
              signal.throwIfAborted()
            } while (cursor)
          } else if (source?.kind === "organization" && source.resource) {
            const contract = await OrganizationSessionResources.read(current.session)
            const selected = contract?.selection?.infrastructure.workspace
            if (
              selected?.resourceID !== source.resource.resourceID ||
              selected.workspaceID !== source.resource.workspaceID
            )
              fail("PROTOCOL_MISMATCH", "Handoff source no longer matches its Session Workspace resource")
            await OrganizationSessionResources.enabled(current.session, contract!.selection!)
            const catalog = await WorkspaceCatalog.get(
              source.resource.workspaceID,
              OrganizationCloud.scopeID(current.session.orgID, current.session.projectID),
            )
            if (catalog.activeMount || catalog.binding.generation !== source.resource.generation)
              fail("RESOURCE_UNAVAILABLE", "Handoff source requires its current dormant Workspace generation")
            const completeRoot =
              source.resource.path !== "" ||
              admitted.participants.every((participant) => participant.connection.handshake.schemas.handoffs >= 7)
            if (completeRoot) choices.push({ kind: "organization-live", requiresDifference: false })
            if (
              completeRoot &&
              native &&
              admitted.participants.every((participant) => participant.connection.handshake.schemas.handoffs >= 5)
            )
              choices.push({ kind: "organization-native", targetKind: "existing", requiresDifference: true })
            if (
              completeRoot &&
              current.target.runtimeKind === "member" &&
              !contract?.selection?.infrastructure.environment &&
              admitted.participants.every((participant) => participant.connection.handshake.schemas.handoffs >= 6)
            )
              choices.push({ kind: "organization-native", targetKind: "private-copy", requiresDifference: false })
          }
          for (const participant of admitted.participants) {
            signal.throwIfAborted()
            participant.connection.assertCurrent()
            if (participant.authorization.plan.expiresAt <= Date.now())
              fail("PERMISSION_DENIED", "Handoff inspection authorization expired")
          }
          return Handoff.Options.parse({
            sessionID,
            projectID: current.session.projectID,
            bindingEpoch: current.session.bindingEpoch,
            controlRevision: current.session.controlRevision,
            sourceRuntimeID: current.source.runtimeID,
            targetRuntimeID: current.target.runtimeID,
            source,
            native,
            choices,
          })
        })
      } finally {
        inspections--
      }
    },
    async withWorkspace<T>(
      value: Cloud.HandoffWorkspaceRequest,
      signal: AbortSignal | undefined,
      body: (evidence: OrganizationHandoffExecution.WorkspaceAuthority) => Promise<T>,
    ): Promise<T> {
      if (Storage.inTransaction()) fail("INVALID_REQUEST", "Workspace handoff authority must precede publication")
      const request = Cloud.HandoffWorkspaceRequest.parse(value)
      const proof = request.proof
      const owner = WorkspaceContent.captureOwner(signal)
      const window = () => {
        owner()
        if (proof.issuedAt > Date.now() || proof.expiresAt <= Date.now())
          fail("PERMISSION_DENIED", "Workspace handoff proof is outside its signing window")
      }
      window()
      const authority = await Storage.snapshot(() => runtimeAuthority(proof))
      if (!(await Cloud.verifyHandoffWorkspace(proof, request.signature, authority.runtime.publicKey)))
        fail("PERMISSION_DENIED", "Workspace handoff requires its complete signed operation")
      window()
      const connection = options.connections.captureHandoff(proof.runtimeID)
      assertRuntimeConnection(authority.runtime, connection.handshake)
      if (connection.handshake.schemas.handoffs < 2)
        fail("PROTOCOL_MISMATCH", "Workspace handoff requires the complete mapped file reader")
      let open = true
      let retained: WorkspaceMove.Request | undefined
      let source: WorkspaceFrame["source"]
      let scopeID: string | undefined
      const assert = () => {
        window()
        connection.assertCurrent()
        if (!open) fail("PERMISSION_DENIED", "Workspace handoff callback has ended")
      }
      const recheck = async () => {
        assert()
        await Storage.snapshot(async () => {
          const record = await load(proof.handoffID)
          if (
            bindingFields.some((field) => record[field] !== proof[field]) ||
            record.request.workspaceMapping.kind === "native" ||
            proof.mappingHash !== (await Handoff.mappingHash(record.request.workspaceMapping))
          )
            fail("PROTOCOL_MISMATCH", "Workspace handoff belongs to another original mapping")
          const publishing = proof.operation.action === "put" || proof.operation.action === "publish"
          if (
            record.cancelRequested ||
            (publishing
              ? record.phase !== "preparing" || !!record.frozen
              : !["preparing", "prepared", "surrendered", "committed", "activation_permitted"].includes(record.phase))
          )
            fail("HANDOFF_BLOCKED", "Workspace handoff is unavailable in this phase")
          const participant = proof.runtimeID === record.sourceRuntimeID ? record.source : record.target
          if (participant.publicKey !== authority.runtime.publicKey)
            fail("PERMISSION_DENIED", "Workspace handoff machine changed")
          const access = await eligible(record)
          scopeID = OrganizationCloud.scopeID(record.orgID, access.current.projectID)
          const mapping = record.request.workspaceMapping
          if (mapping.kind === "organization-live" || mapping.kind === "organization-native") {
            if (wholeWorkspace(mapping) && connection.handshake.schemas.handoffs < 7)
              fail("HANDOFF_BLOCKED", "Whole Workspace handoff requires both participants' root reader")
            if (
              connection.handshake.schemas.handoffs < 3 ||
              !["source", "source-object", "source-validate"].includes(proof.operation.action)
            )
              fail("PROTOCOL_MISMATCH", "Live Workspace handoff requires its source snapshot protocol")
            if (source && !same(source, mapping.resource)) fail("PROTOCOL_MISMATCH", "Live Workspace source changed")
            source ??= mapping.resource
          } else {
            if (["source", "source-object", "source-validate"].includes(proof.operation.action))
              fail("PROTOCOL_MISMATCH", "Object publication cannot substitute a live source")
            const selected = workspaceRequest(record, access.current.projectID)
            if (!selected || (retained && !same(selected, retained)))
              fail("PROTOCOL_MISMATCH", "Workspace handoff target changed")
            retained ??= selected
          }
          access.guard()
          assert()
        })
        assert()
      }
      try {
        await recheck()
        const evidence: OrganizationHandoffExecution.WorkspaceAuthority = Object.freeze({
          kind: "handoff-workspace-authority",
        })
        if (!scopeID) fail("PROTOCOL_MISMATCH", "Workspace handoff lost its canonical Scope")
        workspaceFrames.set(evidence, {
          scopeID,
          request: retained,
          source,
          proof,
          assert,
          recheck,
          async snapshot() {
            await recheck()
            const snapshot = (await load(proof.handoffID)).workspaceSource
            assert()
            return snapshot
          },
          async retain(value) {
            const snapshot = WorkspaceArchive.Subtree.parse(value)
            return History.system(
              "handoff.workspace-source",
              async (identify, actionID) => {
                await recheck()
                const record = await load(proof.handoffID)
                if (
                  !source ||
                  snapshot.workspaceID !== source.workspaceID ||
                  snapshot.generation !== source.generation ||
                  snapshot.path !== source.path ||
                  snapshot.scopeID !== OrganizationCloud.scopeID(record.orgID, (await session(record)).projectID)
                )
                  fail("PROTOCOL_MISMATCH", "Workspace snapshot changed its authoritative source")
                if (record.workspaceSource) {
                  if (!same(record.workspaceSource, snapshot))
                    fail("REVISION_CONFLICT", "Workspace source cannot replace its captured head")
                  return record.workspaceSource
                }
                if (record.phase !== "preparing" || record.frozen)
                  fail("HANDOFF_BLOCKED", "Workspace source capture must precede its final freeze")
                const current = await WorkspaceCatalog.get(snapshot.workspaceID, snapshot.scopeID)
                if (
                  current.activeMount ||
                  current.binding.generation !== snapshot.generation ||
                  current.revision !== snapshot.revision ||
                  (current.content?.manifest ?? null) !== snapshot.head
                )
                  fail("REVISION_CONFLICT", "Workspace source changed during capture")
                identify({
                  kind: "system",
                  orgID: record.orgID,
                  subjectID: proof.runtimeID,
                  displayName: "Workspace source capture",
                  clientKind: "runtime",
                  requestID: actionID,
                })
                record.workspaceSource = snapshot
                await save(record)
                return snapshot
              },
              { commitGuard: assert },
            )
          },
        })
        const result = await body(evidence)
        assert()
        return result
      } finally {
        open = false
      }
    },
    async continuationAuthority(input: {
      handoffID: string
      sessionID: string
      runtimeID: string
      bindingEpoch: number
      commandSeq: number
    }) {
      if (!Storage.inTransaction()) fail("INVALID_REQUEST", "Execution continuation must join its grant transaction")
      const record = await load(input.handoffID)
      const current = await session(record)
      const cancelled = record.phase === "cancelled" && !!record.cancelled
      const activated = record.phase === "completed" && !!record.activated
      if (
        (!cancelled && !activated) ||
        record.sessionID !== input.sessionID ||
        current.handoffID ||
        record.toEpoch !== current.nextBindingEpoch - 1 ||
        input.commandSeq <= record.commandSeq ||
        current.driverRuntimeID !== input.runtimeID ||
        current.bindingEpoch !== input.bindingEpoch ||
        input.runtimeID !== (cancelled ? record.sourceRuntimeID : record.targetRuntimeID) ||
        input.bindingEpoch !== (cancelled ? record.fromEpoch : record.toEpoch)
      )
        fail(
          "HANDOFF_BLOCKED",
          "Execution continuation requires the latest permanent handoff outcome and a fresh control",
        )
      const mapping = record.request.workspaceMapping
      const workspaceContinuation =
        !cancelled &&
        (mapping.kind === "organization-object" || mapping.kind === "organization-native") &&
        record.workspaceContract
          ? {
              before: record.workspaceContract,
              after: OrganizationSessionResources.mappedWorkspace(
                record.workspaceContract,
                mapping.kind === "organization-native" ? null : mapping.target,
              ),
            }
          : undefined
      return {
        current,
        sourceRuntimeID: record.sourceRuntimeID,
        sourceBindingEpoch: record.fromEpoch,
        cancelled,
        workspaceContinuation,
      }
    },
    async executionAuthority(proof: Execution.HandoffCloseProof | Execution.HandoffInventoryProof) {
      if (!Storage.inTransaction()) fail("INVALID_REQUEST", "Handoff resource closure must join its grant transaction")
      const record = await load(proof.handoffID)
      if (bindingFields.some((field) => record[field] !== proof[field]))
        fail("PROTOCOL_MISMATCH", "Execution resource closure has another handoff binding")
      if (
        record.phase !== "prepared" ||
        record.cancelRequested ||
        !record.frozen ||
        !record.prepared ||
        record.surrendered
      )
        fail("HANDOFF_BLOCKED", "Execution resources require the current prepared handoff")
      if (
        record.manifestHash !== proof.manifestHash ||
        (await Handoff.proofHash(record.prepared.proof)) !== proof.preparedHash
      )
        fail("PROTOCOL_MISMATCH", "Execution resource closure has another immutable preparation")
      return eligible(record)
    },
    async object(value: Objects.Request, input: { signal: AbortSignal }): Promise<z.infer<typeof Handoff.ObjectChunk>> {
      const request = Objects.Request.parse(value)
      input.signal.throwIfAborted()
      const authorized = await Storage.snapshot(async () => {
        const access = await objectAuthority(request)
        const record = access.record
        const issuedAt = Date.now()
        const authorization = await options.signing.signHandoffMachine(
          Handoff.MachinePlan.strip().parse({
            ...record,
            purpose: "handoff-machine",
            operation: "object",
            requestID: request.proof.requestID,
            keyID: options.signing.identity.keyID,
            runtimeID: record.sourceRuntimeID,
            connectionEpoch: access.source.handshake.connectionEpoch,
            controlRevision: access.current.controlRevision,
            authRevision: access.account?.authRevision ?? 0,
            sourceBinding: {
              schemaVersion: 1,
              orgID: record.orgID,
              projectID: access.current.projectID,
              creatorID: access.current.creatorID,
              driverRuntimeID: record.sourceRuntimeID,
              bindingEpoch: record.fromEpoch,
            },
            actor: {
              kind: "system",
              orgID: record.orgID,
              subjectID: record.targetRuntimeID,
              displayName: "Destination Runtime",
              clientKind: "runtime",
              requestID: request.proof.requestID,
            },
            object: request.proof.range,
            issuedAt,
            expiresAt: Math.min(issuedAt + timeoutMs, request.proof.expiresAt),
          }),
        )
        return { ...access, authorization }
      })
      const reply = await authorized.source.exchange(
        { kind: "handoff", authorization: authorized.authorization },
        { signal: input.signal, deadline: authorized.authorization.plan.expiresAt },
      )
      input.signal.throwIfAborted()
      authorized.source.assertCurrent()
      authorized.target.assertCurrent()
      if (reply.kind === "error") throw new OrganizationError(reply.error)
      if (
        reply.kind !== "handoff" ||
        !Handoff.matchesMachine(authorized.authorization.plan, reply.result) ||
        reply.result.state !== "complete" ||
        reply.result.facts.length ||
        !reply.result.object
      )
        fail("PROTOCOL_MISMATCH", "Handoff source returned another object range")
      await Storage.snapshot(async () => {
        await objectAuthority(request)
        authorized.source.assertCurrent()
        authorized.target.assertCurrent()
      })
      return reply.result.object
    },
    async drive(
      credentials: Credentials,
      handoffID: string,
      value: Handoff.Drive,
      input: { signal: AbortSignal },
    ): Promise<Handoff.MachineResult> {
      const request = Handoff.Drive.parse(value)
      input.signal.throwIfAborted()
      const authorized = await Storage.snapshot(async () => {
        const record = await load(handoffID)
        const access = await machineAccess(credentials, record, request.operation)
        const role = Handoff.machineRole(request.operation)
        const required =
          role === "source"
            ? record.initiator
            : record.target.runtimeKind === "member"
              ? record.target.accountID
              : access.sourceBinding.creatorID
        if (access.account.accountID !== required)
          fail("PERMISSION_DENIED", "This account cannot drive this handoff participant")
        const inspect = request.operation.startsWith("inspect-")
        if (!inspect) {
          if (access.cleanup) {
            if (record.activated || record.surrendered)
              fail("HANDOFF_BLOCKED", "Activated native adoption cannot be cancelled")
          } else if (request.operation === "cancel-source") {
            if (
              !record.cancelRequested ||
              record.surrendered ||
              ["completed", "cancelled", "retired"].includes(record.phase)
            )
              fail("HANDOFF_BLOCKED", "Source cancellation is unavailable in this phase")
          } else {
            await eligible(record)
            const phases: Record<string, string[]> = {
              "prepare-source": ["preparing"],
              "preview-target": ["preparing"],
              "prepare-target": ["preparing", "prepared"],
              "surrender-source": ["prepared"],
              "activate-target": ["activation_permitted"],
              "retire-target": ["surrendered", "committed", "activation_permitted"],
            }
            if (record.cancelRequested || !phases[request.operation]?.includes(record.phase))
              fail("HANDOFF_BLOCKED", "Handoff machine operation is unavailable in this phase")
          }
        }
        const runtime = role === "source" ? record.source : record.target
        const connection = options.connections.captureHandoff(runtime.runtimeID)
        const mapping = record.request.workspaceMapping
        if (wholeWorkspace(mapping) && connection.handshake.schemas.handoffs < 7)
          fail("HANDOFF_BLOCKED", "Whole Workspace handoff requires both participants' root reader")
        if (
          mapping.kind === "organization-native" &&
          connection.handshake.schemas.handoffs < (mapping.target.kind === "private-copy" ? 6 : 5)
        )
          fail("HANDOFF_BLOCKED", "Native Workspace handoff requires its complete target receipt reader")
        if (
          request.operation === "preview-target" &&
          (mapping.kind !== "organization-native" || mapping.target.kind !== "existing")
        )
          fail("HANDOFF_BLOCKED", "This mapping has no existing native difference")
        if (
          request.operation === "prepare-target" &&
          mapping.kind === "organization-native" &&
          mapping.target.kind === "existing" &&
          !record.differenceConsent
        )
          fail("HANDOFF_BLOCKED", "Review and accept the exact native target difference before preparation")
        if (record.request.workspaceMapping.kind === "organization-object" && connection.handshake.schemas.handoffs < 2)
          fail("HANDOFF_BLOCKED", "Object Workspace handoff requires the complete mapped file reader")
        const authority = await runtimeAuthority({
          runtimeID: runtime.runtimeID,
          orgID: record.orgID,
          deploymentIncarnation: record.deploymentIncarnation,
          connectionEpoch: connection.handshake.connectionEpoch,
        })
        assertRuntimeConnection(authority.runtime, connection.handshake)
        if (authority.runtime.publicKey !== runtime.publicKey)
          fail("PERMISSION_DENIED", "Handoff machine identity changed")
        const issuedAt = Date.now()
        const expiresAt = Math.min(issuedAt + timeoutMs, access.expiresAt)
        if (expiresAt <= issuedAt) fail("AUTHENTICATION_REQUIRED", "Handoff authorization expired before dispatch")
        const plan = Handoff.MachinePlan.strip().parse({
          ...record,
          ...request,
          workspacePlan:
            connection.handshake.schemas.handoffs >= 2
              ? {
                  mapping: record.request.workspaceMapping,
                  hash: await Handoff.mappingHash(record.request.workspaceMapping),
                  selectionActor: record.selectionActor,
                  targetActor: record.targetActor,
                  differenceConsent: record.differenceConsent,
                  difference: record.difference?.proof.difference,
                  targetScopeID:
                    record.request.workspaceMapping.kind !== "native"
                      ? OrganizationCloud.scopeID(record.orgID, access.sourceBinding.projectID)
                      : undefined,
                }
              : undefined,
          purpose: "handoff-machine",
          keyID: options.signing.identity.keyID,
          runtimeID: runtime.runtimeID,
          connectionEpoch: connection.handshake.connectionEpoch,
          controlRevision: access.controlRevision,
          authRevision: access.account.authRevision,
          actor: {
            kind: "account",
            orgID: record.orgID,
            subjectID: access.account.accountID,
            displayName: access.account.displayName,
            clientKind: access.clientKind,
            requestID: request.requestID,
            ...("tokenID" in access ? { tokenID: access.tokenID } : {}),
          },
          sourceBinding: access.sourceBinding,
          cleanup: access.cleanup ? record.cancelled : undefined,
          ...(request.operation === "surrender-source"
            ? { authorization: record.surrenderPermit }
            : request.operation === "activate-target"
              ? { authorization: record.activationPermit }
              : {}),
          preparedHash: record.prepared ? await Handoff.proofHash(record.prepared.proof) : undefined,
          issuedAt,
          expiresAt,
        })
        const authorization = await options.signing.signHandoffMachine(plan)
        connection.assertCurrent()
        return { authorization, connection, cleanup: access.cleanup }
      })
      const reply = await authorized.connection.exchange(
        { kind: "handoff", authorization: authorized.authorization },
        { signal: input.signal, deadline: authorized.authorization.plan.expiresAt },
      )
      authorized.connection.assertCurrent()
      if (reply.kind === "error") throw new OrganizationError(reply.error)
      if (reply.kind !== "handoff" || !Handoff.matchesMachine(authorized.authorization.plan, reply.result))
        fail("PROTOCOL_MISMATCH", "Handoff machine returned another operation")
      if (
        authorized.cleanup &&
        (reply.result.object ||
          reply.result.workspaceDifference ||
          reply.result.differencePage ||
          reply.result.requirements.length ||
          reply.result.facts.some(
            ({ proof }) => proof.purpose !== "target-never-activate" && proof.purpose !== "target-preview-released",
          ))
      )
        fail("PROTOCOL_MISMATCH", "Cancelled native cleanup cannot disclose a Session view or prepare execution")
      for (const fact of reply.result.facts) await api.proof(fact)
      await Storage.snapshot(async () => {
        const record = await load(handoffID)
        const access = await machineAccess(credentials, record, request.operation)
        if (access.cleanup !== authorized.cleanup)
          fail("PERMISSION_DENIED", "Handoff read authority changed while its original response was pending")
        if (access.cleanup) assertRuntimeConnection(access.runtime, authorized.connection.handshake)
        authorized.connection.assertCurrent()
      })
      return reply.result
    },
    async prepare(credentials: Credentials, sessionID: string, value: Handoff.Prepare) {
      const request = Handoff.Prepare.parse(value)
      const guards: Array<() => void> = []
      return History.credentials(
        credentials,
        "handoff.prepare",
        async () => {
          const access = await authorize(credentials, "session.read", { sessionID })
          await authorize(credentials, "project.execute", { projectID: access.session.projectID })
          const [existing] = await Storage.readMany([key(request.handoffID)])
          if (existing) {
            const previous = Stored.parse(upgradeAccessRecord(key(request.handoffID), existing))
            if (
              previous.sessionID !== sessionID ||
              previous.initiator !== access.account.accountID ||
              !same(previous.request, request)
            )
              fail("REVISION_CONFLICT", "Handoff identity belongs to a different request")
            return view(previous, access.account.accountID)
          }
          const current = access.session
          if (current.handoffID) fail("HANDOFF_BLOCKED", "Another handoff owns this Session")
          revision(request.expectedBindingEpoch, current.bindingEpoch)
          revision(request.expectedControlRevision, current.controlRevision)
          if (request.workspaceMapping.kind === "organization-object") {
            const mapping = request.workspaceMapping
            const selected = await authorize(credentials, "resource.use", {
              resourceID: mapping.target.resourceID,
              projectID: current.projectID,
            })
            if (selected.resource.configuration.protocol !== "workspace-storage")
              fail("INVALID_REQUEST", "Workspace mapping requires its storage resource")
            const workspace = await OrganizationCloud.getWorkspace(credentials, mapping.target.workspaceID)
            if (
              workspace.resourceID !== mapping.target.resourceID ||
              workspace.projectID !== current.projectID ||
              workspace.activeMount
            )
              fail("HANDOFF_BLOCKED", "Workspace mapping requires its dormant target resource")
            revision(mapping.target.generation, workspace.generation)
            revision(mapping.target.expectedRevision, workspace.revision)
          }
          const source = await Record.read(Record.RuntimeRegistration, Keys.runtime(current.driverRuntimeID))
          const target = await Record.read(Record.RuntimeRegistration, Keys.runtime(request.targetRuntimeID))
          if (
            !source ||
            !target ||
            source.orgID !== current.orgID ||
            target.orgID !== current.orgID ||
            source.runtimeID === target.runtimeID
          )
            fail("NOT_FOUND", "Handoff destination is unavailable")
          if (request.workspaceMapping.kind === "organization-native" && target.runtimeKind !== "member")
            fail("HANDOFF_BLOCKED", "A native Workspace requires its destination member")
          if (
            request.workspaceMapping.kind === "organization-native" &&
            request.workspaceMapping.target.kind === "private-copy" &&
            (await OrganizationSessionResources.read(current))?.selection?.infrastructure.environment
          )
            fail(
              "HANDOFF_BLOCKED",
              "Downloading a native Workspace requires an explicit compatible Environment mapping",
            )
          if (access.account.accountID !== (source.runtimeKind === "member" ? source.accountID : current.creatorID))
            fail("PERMISSION_DENIED", "Only the current execution owner can initiate a handoff")
          if (
            target.runtimeKind === "member" &&
            target.accountID !== current.creatorID &&
            current.shareState !== "shared"
          )
            fail("HANDOFF_BLOCKED", "Share this Session before handing it to another member")
          const command = await Record.read(Record.CommandState, Keys.commandState(sessionID))
          const record = Stored.parse({
            schemaVersion: 1,
            version: 3,
            selectionActor: {
              kind: "account",
              orgID: access.account.orgID,
              subjectID: access.account.accountID,
              displayName: access.account.displayName,
              clientKind: access.clientKind,
              requestID: request.handoffID,
              ...("tokenID" in access ? { tokenID: access.tokenID } : {}),
            },
            orgID: current.orgID,
            deploymentIncarnation: options.signing.identity.deploymentIncarnation,
            handoffID: request.handoffID,
            sessionID,
            sourceRuntimeID: source.runtimeID,
            targetRuntimeID: target.runtimeID,
            fromEpoch: current.bindingEpoch,
            toEpoch: current.nextBindingEpoch,
            mappingPlanRevision: request.mappingPlanRevision,
            shareGeneration: current.shareGeneration,
            phase: "preparing",
            initiator: access.account.accountID,
            targetAccepted: target.runtimeKind === "hosted",
            commandSeq: command?.commandSeq ?? 0,
            source: publicRuntime(source),
            target: publicRuntime(target),
            request,
            workspaceContract:
              request.workspaceMapping.kind === "organization-object" ||
              request.workspaceMapping.kind === "organization-native"
                ? await OrganizationSessionResources.read(current)
                : undefined,
            ...(request.workspaceMapping.kind === "organization-native"
              ? {
                  sourceBinding: {
                    schemaVersion: 1,
                    orgID: current.orgID,
                    projectID: current.projectID,
                    creatorID: current.creatorID,
                    driverRuntimeID: current.driverRuntimeID,
                    bindingEpoch: current.bindingEpoch,
                  },
                  sourceControlRevision: current.controlRevision + 1,
                }
              : {}),
            cancelRequested: false,
          })
          const sourceLease = options.connections.capture(source.runtimeID)
          const targetLease = options.connections.capture(target.runtimeID)
          for (const [runtime, lease] of [
            [source, sourceLease],
            [target, targetLease],
          ] as const) {
            const files = options.connections.captureHandoff(runtime.runtimeID)
            files.assertCurrent()
            if (wholeWorkspace(request.workspaceMapping) && files.handshake.schemas.handoffs < 7)
              fail("HANDOFF_BLOCKED", "Whole Workspace handoff requires both participants' root reader")
            if (request.workspaceMapping.kind === "organization-object" && files.handshake.schemas.handoffs < 2)
              fail("HANDOFF_BLOCKED", "Both participants must support complete mapped Workspace files")
            if (request.workspaceMapping.kind === "organization-live" && files.handshake.schemas.handoffs < 3)
              fail("HANDOFF_BLOCKED", "Both participants must support live Workspace source snapshots")
            if (
              request.workspaceMapping.kind === "organization-native" &&
              (target.runtimeKind !== "member" ||
                files.handshake.schemas.handoffs < (request.workspaceMapping.target.kind === "private-copy" ? 6 : 5))
            )
              fail("HANDOFF_BLOCKED", "Native Workspace handoff requires two compatible readers and its target member")
            await runtimeAuthority({
              runtimeID: runtime.runtimeID,
              orgID: current.orgID,
              deploymentIncarnation: record.deploymentIncarnation,
              connectionEpoch: lease.handshake.connectionEpoch,
            })
            assertRuntimeConnection(runtime, lease.handshake)
            guards.push(() => lease.assertCurrent())
            if (runtime.runtimeKind === "member") await accountExecution(runtime.accountID, current)
          }
          await Storage.write(
            Keys.session(sessionID),
            Record.SessionDirectory.parse({
              ...current,
              nextBindingEpoch: record.toEpoch + 1,
              handoffID: record.handoffID,
              controlRevision: current.controlRevision + 1,
              rowRevision: current.rowRevision + 1,
            }),
          )
          await save(record)
          const move = workspaceRequest(record, current.projectID)
          if (move) await WorkspaceMove.reserve(move)
          await Storage.write([...sessionKey(sessionID), record.handoffID], { handoffID: record.handoffID })
          await OrganizationHandoffExecution.index(record)
          return view(record, access.account.accountID)
        },
        {
          commitGuard: () => {
            for (const guard of guards) guard()
          },
        },
      )
    },
    async get(credentials: Credentials, handoffID: string) {
      return Storage.snapshot(async () => {
        const record = await load(handoffID)
        const { account } = await authorize(credentials, "session.read", { sessionID: record.sessionID })
        return view(record, account.accountID)
      })
    },
    async list(credentials: Credentials, sessionID: string, input: Identity.Page) {
      const page = Identity.Page.parse(input)
      return Storage.snapshot(async () => {
        const { account } = await authorize(credentials, "session.read", { sessionID })
        const prefix = sessionKey(sessionID)
        const rows = await Storage.query({
          prefix,
          after: page.cursor ? [...prefix, page.cursor] : undefined,
          limit: page.limit + 1,
        })
        const items = await Promise.all(
          rows
            .slice(0, page.limit)
            .map(async (row) => view(await load(Identity.ID.parse(row.key.at(-1))), account.accountID)),
        )
        return { items, cursor: rows.length > page.limit ? items.at(-1)?.handoffID : undefined }
      })
    },
    async accept(credentials: Credentials, handoffID: string, value: Handoff.Accept) {
      const input = Handoff.Accept.parse(value)
      const guards: Array<() => void> = []
      return History.credentials(
        credentials,
        "handoff.accept",
        async () => {
          const record = await load(handoffID)
          const access = await authorize(credentials, "session.read", {
            sessionID: record.sessionID,
          })
          const { account, session: current } = access
          await authorize(credentials, "project.execute", { projectID: current.projectID })
          if (record.target.runtimeKind !== "member" || record.target.accountID !== account.accountID)
            fail("PERMISSION_DENIED", "Only the destination Runtime's member can accept")
          revision(input.mappingPlanRevision, record.mappingPlanRevision)
          if (
            ("mappingHash" in input &&
              input.mappingHash !== (await Handoff.mappingHash(record.request.workspaceMapping))) ||
            (record.request.workspaceMapping.kind !== "native" && !("mappingHash" in input))
          )
            fail("REVISION_CONFLICT", "Destination consent must bind the complete original Workspace mapping")
          if (record.phase !== "preparing" || record.cancelRequested)
            fail("HANDOFF_BLOCKED", "This handoff cannot accept a target")
          if ("workspaceDifference" in input) {
            const difference = record.difference?.proof.difference
            if (
              record.request.workspaceMapping.kind !== "organization-native" ||
              record.request.workspaceMapping.target.kind !== "existing" ||
              !record.targetAccepted ||
              !difference ||
              !same(input.workspaceDifference, Handoff.DifferenceConsent.strip().parse(difference))
            )
              fail("REVISION_CONFLICT", "Destination consent must bind the complete current native difference")
            if (record.differenceConsent && !same(record.differenceConsent, input.workspaceDifference))
              fail("REVISION_CONFLICT", "An accepted native difference cannot change")
            const current = await eligible(record)
            guards.push(current.guard)
            record.differenceConsent = input.workspaceDifference
            record.differenceActor = {
              kind: "account",
              orgID: account.orgID,
              subjectID: account.accountID,
              displayName: account.displayName,
              clientKind: access.clientKind,
              requestID: record.handoffID,
              ...("tokenID" in access ? { tokenID: access.tokenID } : {}),
            }
          } else if (record.request.workspaceMapping.kind === "organization-native" && !record.targetAccepted)
            record.targetActor = {
              kind: "account",
              orgID: account.orgID,
              subjectID: account.accountID,
              displayName: account.displayName,
              clientKind: access.clientKind,
              requestID: record.handoffID,
              ...("tokenID" in access ? { tokenID: access.tokenID } : {}),
            }
          record.targetAccepted = true
          await save(record)
          return view(record, account.accountID)
        },
        {
          commitGuard() {
            for (const guard of guards) guard()
          },
        },
      )
    },
    async cancel(credentials: Credentials, handoffID: string) {
      return History.credentials(credentials, "handoff.cancel", async () => {
        const record = await load(handoffID)
        await initiator(credentials, record)
        if (record.phase === "cancelled") return view(record, record.initiator)
        if (record.surrendered || ["committed", "activation_permitted", "completed", "retired"].includes(record.phase))
          fail("HANDOFF_BLOCKED", "Source surrender is irreversible")
        record.cancelRequested = true
        await save(record)
        return view(record, record.initiator)
      })
    },
    async permit(credentials: Credentials, handoffID: string, value: Handoff.PermitRequest) {
      const input = Handoff.PermitRequest.parse(value)
      const guards: Array<() => void> = []
      return History.credentials(
        credentials,
        "handoff.permit",
        async () => {
          const record = await load(handoffID)
          const { account } = await authorize(credentials, "session.read", { sessionID: record.sessionID })
          await authorize(credentials, "project.execute", { projectID: (await session(record)).projectID })
          const activation = input.purpose === "handoff-activation"
          const required =
            activation && record.target.runtimeKind === "member" ? record.target.accountID : record.initiator
          if (account.accountID !== required)
            fail("PERMISSION_DENIED", "This account cannot request the handoff permit")
          const previous = activation ? record.activationPermit : record.surrenderPermit
          if (previous) return previous
          if (record.cancelRequested || !record.frozen || !record.prepared || !record.manifestHash || record.retired)
            fail("HANDOFF_BLOCKED", "Handoff preparation is incomplete")
          if (activation ? record.phase !== "committed" : record.phase !== "prepared")
            fail("HANDOFF_BLOCKED", "Handoff is not ready for this permit")
          const allowed = await eligible(record)
          guards.push(allowed.guard)
          const permit = Handoff.Permit.strip().parse({
            ...record,
            purpose: input.purpose,
            permitID: crypto.randomUUID(),
            keyID: options.signing.identity.keyID,
            sourceBinding: {
              schemaVersion: 1,
              orgID: record.orgID,
              projectID: allowed.current.projectID,
              creatorID: allowed.current.creatorID,
              driverRuntimeID: record.sourceRuntimeID,
              bindingEpoch: record.fromEpoch,
            },
            manifestHash: record.manifestHash,
            preparedHash: await Handoff.proofHash(record.prepared.proof),
            createdAt: Date.now(),
          })
          const signed = await options.signing.signHandoff(permit)
          if (activation) {
            record.activationPermit = signed
            record.phase = "activation_permitted"
          } else record.surrenderPermit = signed
          await save(record)
          return signed
        },
        {
          commitGuard: () => {
            for (const guard of guards) guard()
          },
        },
      )
    },
    async commit(credentials: Credentials, handoffID: string) {
      const guards: Array<() => void> = []
      return History.credentials(
        credentials,
        "handoff.commit",
        async () => {
          const record = await load(handoffID)
          await initiator(credentials, record)
          if (["committed", "activation_permitted", "completed"].includes(record.phase))
            return view(record, record.initiator)
          if (record.phase !== "surrendered" || !record.surrendered || !record.prepared)
            fail("HANDOFF_BLOCKED", "Source surrender and destination preparation are required")
          const allowed = await eligible(record)
          guards.push(allowed.guard)
          if (allowed.current.retainedExecutionGrants)
            fail("HANDOFF_BLOCKED", "Source execution resources have not drained")
          const mapping = record.request.workspaceMapping
          let resourceIDs = allowed.current.resourceIDs
          if (mapping.kind === "organization-object" || mapping.kind === "organization-native") {
            if (!record.workspaceContract)
              fail("HANDOFF_BLOCKED", "Workspace mapping has no original resource contract")
            if (mapping.kind === "organization-object") {
              const receipt = await WorkspaceMove.validate(workspaceRequest(record, allowed.current.projectID)!)
              if (
                record.prepared.proof.purpose !== "target-prepared" ||
                record.prepared.proof.workspaceMoveReceiptHash !== WorkspaceMove.receiptHash(receipt)
              )
                fail("HANDOFF_BLOCKED", "Workspace mapping has no matching prepared CAS receipt")
            } else if (
              record.prepared.proof.purpose !== "target-prepared" ||
              !record.prepared.proof.workspaceNativeReceiptHash ||
              (mapping.target.kind === "existing"
                ? !record.differenceConsent ||
                  record.prepared.proof.workspaceDifferenceHash !== record.differenceConsent.diffHash
                : record.prepared.proof.workspaceDifferenceHash !== undefined)
            )
              fail("HANDOFF_BLOCKED", "Native mapping has no exact consented target receipt")
            const mapped = await OrganizationSessionResources.rebindHandoff(
              allowed.current,
              record.workspaceContract,
              mapping.kind === "organization-native" ? null : mapping.target,
            )
            resourceIDs = Execution.resourceIDs(mapped.selection!)
          }
          const rebound = Record.SessionDirectory.parse({
            ...allowed.current,
            resourceIDs,
            driverRuntimeID: record.targetRuntimeID,
            bindingEpoch: record.toEpoch,
            controlRevision: allowed.current.controlRevision + 1,
            rowRevision: allowed.current.rowRevision + 1,
          })
          await Storage.write(Keys.session(record.sessionID), rebound)
          await OrganizationSharing.rebind(allowed.current, rebound)
          record.phase = "committed"
          await save(record)
          return view(record, record.initiator)
        },
        {
          commitGuard: () => {
            for (const guard of guards) guard()
          },
        },
      )
    },
    async proof(value: Handoff.SignedProof) {
      const signed = Handoff.SignedProof.parse(value)
      const acknowledgement = Handoff.FactAcknowledgement.parse({
        ...Handoff.Binding.strip().parse(signed.proof),
        purpose: signed.proof.purpose,
        factHash: await Handoff.proofHash(signed.proof),
      })
      const record = await Storage.snapshot(() => load(signed.proof.handoffID))
      const source = signed.proof.purpose.startsWith("source-")
      if (
        !(await Handoff.verifyProof(
          signed.proof,
          signed.signature,
          source ? record.source.publicKey : record.target.publicKey,
        ))
      )
        fail("PERMISSION_DENIED", "Handoff proof signature is invalid")
      const result = await History.system("handoff.proof", async (identify, actionID) => {
        const current = await load(record.handoffID)
        const proof = signed.proof
        if (bindingFields.some((field) => current[field] !== proof[field]))
          fail("PROTOCOL_MISMATCH", "Handoff proof binding does not match")
        if (current.manifestHash && current.manifestHash !== proof.manifestHash)
          fail("PROTOCOL_MISMATCH", "Handoff frozen manifest does not match")
        if (proof.purpose === "target-difference") {
          if (current.difference && same(current.difference, signed)) return acknowledgement
          if (
            current.request.workspaceMapping.kind !== "organization-native" ||
            current.request.workspaceMapping.target.kind !== "existing" ||
            !current.frozen ||
            !current.targetAccepted ||
            current.cancelRequested ||
            current.phase !== "preparing" ||
            current.prepared ||
            !current.workspaceSource ||
            proof.difference.sourceSnapshotHash !== WorkspaceArchive.subtreeHash(current.workspaceSource) ||
            proof.difference.mappingPlanRevision !== current.mappingPlanRevision
          )
            fail("HANDOFF_BLOCKED", "Native difference requires its exact frozen source and inactive destination")
          const access = await eligible(current)
          access.guard()
          if (current.difference && !same(current.difference.proof, proof)) {
            current.differenceConsent = undefined
            current.differenceActor = undefined
          }
          identify({
            kind: "system",
            orgID: current.orgID,
            subjectID: current.targetRuntimeID,
            displayName: "Native target difference",
            clientKind: "runtime",
            requestID: actionID,
          })
          current.difference = Handoff.SignedDifference.parse(signed)
          await save(current)
          return acknowledgement
        }
        if (proof.purpose === "target-preview-released") {
          if (
            current.request.workspaceMapping.kind !== "organization-native" ||
            !current.frozen ||
            current.prepared ||
            current.surrendered ||
            current.activated ||
            (!current.cancelRequested && current.phase !== "cancelled") ||
            proof.diffHash !== (current.difference?.proof.difference.diffHash ?? null)
          )
            fail("HANDOFF_BLOCKED", "Preview release requires its exact cancelled inactive destination")
          if (current.previewReleased && !same(current.previewReleased, signed))
            fail("PROTOCOL_MISMATCH", "An inactive release fact cannot change")
          identify({
            kind: "system",
            orgID: current.orgID,
            subjectID: current.targetRuntimeID,
            displayName: "Inactive native target release",
            clientKind: "runtime",
            requestID: actionID,
          })
          current.previewReleased = signed
          await save(current)
          return acknowledgement
        }
        const slot =
          proof.purpose === "source-frozen"
            ? "frozen"
            : proof.purpose === "target-prepared"
              ? "prepared"
              : proof.purpose === "source-surrendered"
                ? "surrendered"
                : proof.purpose === "source-cancelled"
                  ? "cancelled"
                  : proof.purpose === "target-activated"
                    ? "activated"
                    : "retired"
        const previous = current[slot]
        if (previous) {
          if (!same(previous, signed)) fail("PROTOCOL_MISMATCH", "A persisted handoff fact cannot change")
          return acknowledgement
        }
        if (
          proof.purpose === "target-never-activate" &&
          current.request.workspaceMapping.kind === "organization-native" &&
          current.phase === "cancelled"
        ) {
          if (
            current.activated ||
            current.surrendered ||
            !current.prepared ||
            proof.preparedHash !== (await Handoff.proofHash(current.prepared.proof))
          )
            fail("HANDOFF_BLOCKED", "Cancelled native retirement requires its exact original inactive preparation")
          identify({
            kind: "system",
            orgID: current.orgID,
            subjectID: current.targetRuntimeID,
            displayName: "Cancelled native target retirement",
            clientKind: "runtime",
            requestID: actionID,
          })
          current.retired = signed
          await save(current)
          return acknowledgement
        }
        const directory = await session(current)
        const cancelledNativeRetirement =
          proof.purpose === "target-never-activate" &&
          current.request.workspaceMapping.kind === "organization-native" &&
          current.phase === "cancelled"
        if (
          !cancelledNativeRetirement &&
          (directory.handoffID !== current.handoffID || ["completed", "cancelled", "retired"].includes(current.phase))
        )
          fail("HANDOFF_BLOCKED", "Handoff is already terminal")
        identify({
          kind: "system",
          orgID: current.orgID,
          subjectID: source ? current.sourceRuntimeID : current.targetRuntimeID,
          displayName: "Runtime handoff proof",
          clientKind: "runtime",
          requestID: actionID,
        })
        if (proof.purpose === "source-frozen") {
          if (
            current.phase !== "preparing" ||
            current.cancelRequested ||
            proof.commandSeq !== current.commandSeq ||
            proof.receivedSeq !== current.commandSeq
          )
            fail("HANDOFF_BLOCKED", "Source command barrier is incomplete")
          const move = workspaceRequest(current, directory.projectID)
          if (move) {
            const receipt = await WorkspaceMove.validate(move)
            if (proof.workspaceMoveReceiptHash !== WorkspaceMove.receiptHash(receipt))
              fail("HANDOFF_BLOCKED", "Source fact omits its complete consented Workspace move receipt")
          } else if (proof.workspaceMoveReceiptHash !== null)
            fail("PROTOCOL_MISMATCH", "Native mapping cannot claim an unrelated Workspace move")
          if (
            current.request.workspaceMapping.kind === "organization-live" ||
            current.request.workspaceMapping.kind === "organization-native"
          ) {
            if (
              !current.workspaceSource ||
              proof.workspaceSourceHash !== WorkspaceArchive.subtreeHash(current.workspaceSource)
            )
              fail("HANDOFF_BLOCKED", "Source fact omits its complete current Workspace snapshot")
          } else if (proof.workspaceSourceHash != null)
            fail("PROTOCOL_MISMATCH", "Workspace mapping cannot claim an unrelated source snapshot")
          current.manifestHash = proof.manifestHash
        } else if (proof.purpose === "target-prepared") {
          const frozen = current.frozen?.proof
          if (
            !current.targetAccepted ||
            !frozen ||
            frozen.purpose !== "source-frozen" ||
            current.cancelRequested ||
            proof.compatibilityHash !== frozen.compatibilityHash ||
            proof.closureHash !== frozen.closureHash ||
            proof.fileClosureHash !== frozen.fileClosureHash ||
            proof.workspaceMoveReceiptHash !== frozen.workspaceMoveReceiptHash ||
            (proof.workspaceSourceHash ?? null) !== (frozen.workspaceSourceHash ?? null)
          )
            fail("HANDOFF_BLOCKED", "Destination preparation does not preserve the frozen closure")
          if (current.request.workspaceMapping.kind === "organization-native") {
            if (
              !proof.workspaceNativeReceiptHash ||
              (current.request.workspaceMapping.target.kind === "existing"
                ? !current.differenceConsent || proof.workspaceDifferenceHash !== current.differenceConsent.diffHash
                : proof.workspaceDifferenceHash !== undefined)
            )
              fail("HANDOFF_BLOCKED", "Native target preparation requires its complete accepted difference and receipt")
          } else if (proof.workspaceNativeReceiptHash || proof.workspaceDifferenceHash)
            fail("PROTOCOL_MISMATCH", "Non-native target cannot borrow a native adoption receipt")
          current.phase = "prepared"
        } else if (proof.purpose === "source-surrendered") {
          if (
            current.cancelled ||
            !current.surrenderPermit ||
            !current.prepared ||
            proof.permitID !== current.surrenderPermit.permit.permitID ||
            proof.preparedHash !== (await Handoff.proofHash(current.prepared.proof))
          )
            fail("HANDOFF_BLOCKED", "Source surrender does not match its issued permit")
          current.cancelRequested = false
          current.phase = "surrendered"
        } else if (proof.purpose === "source-cancelled") {
          if (!current.cancelRequested || current.surrendered)
            fail("HANDOFF_BLOCKED", "Cancellation cannot revoke source surrender")
          current.phase = "cancelled"
          await Storage.write(
            Keys.session(current.sessionID),
            Record.SessionDirectory.parse({
              ...directory,
              handoffID: undefined,
              controlRevision: directory.controlRevision + 1,
              rowRevision: directory.rowRevision + 1,
            }),
          )
        } else if (proof.purpose === "target-activated") {
          if (
            current.retired ||
            !current.activationPermit ||
            !current.prepared ||
            proof.permitID !== current.activationPermit.permit.permitID ||
            proof.preparedHash !== (await Handoff.proofHash(current.prepared.proof))
          )
            fail("HANDOFF_BLOCKED", "Destination activation does not match its issued permit")
          current.phase = "completed"
          await Storage.write(
            Keys.session(current.sessionID),
            Record.SessionDirectory.parse({
              ...directory,
              handoffID: undefined,
              controlRevision: directory.controlRevision + 1,
              rowRevision: directory.rowRevision + 1,
            }),
          )
        } else if (proof.purpose === "target-never-activate") {
          if (
            current.activated ||
            (!current.surrendered &&
              !(
                current.request.workspaceMapping.kind === "organization-native" &&
                (current.cancelRequested || current.phase === "cancelled")
              )) ||
            !current.prepared ||
            proof.preparedHash !== (await Handoff.proofHash(current.prepared.proof))
          )
            fail("HANDOFF_BLOCKED", "Destination retirement requires its permanent never-activate proof")
          if (current.surrendered) current.phase = "retired"
        } else {
          fail("HANDOFF_BLOCKED", "Native target difference facts require their owning preparation path")
        }
        current[slot] = signed
        await save(current)
        return acknowledgement
      })
      if (["source-cancelled", "target-activated", "target-never-activate"].includes(signed.proof.purpose)) {
        const current = await Storage.snapshot(() => load(record.handoffID))
        const move = await Storage.snapshot(() => workspaceReleaseRequest(current))
        if (move)
          await WorkspaceMove.release(
            move,
            signed.proof.purpose === "source-cancelled"
              ? "cancelled"
              : signed.proof.purpose === "target-activated"
                ? "activated"
                : "retired",
          )
      }
      return result
    },
  }
  return api
}

export type Handoffs = ReturnType<typeof createHandoffs>
