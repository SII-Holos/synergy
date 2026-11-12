import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationHandoffProtocol as Handoff,
  OrganizationHandoffObjectProtocol as Objects,
  OrganizationIdentity as Identity,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationExecutionProtocol as Execution,
  OrganizationCloudProtocol as Cloud,
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
import { WorkspaceArchive } from "@ericsanchezok/synergy-harness/workspace/archive"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { OrganizationResources } from "./resources"

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
const Stored = LegacyStored.extend({
  version: z.literal(2),
  request: Handoff.CurrentPrepare,
  selectionActor: ActorStamp.Info.nullable(),
  workspaceContract: Record.SessionResources.optional(),
  workspaceSource: WorkspaceArchive.Subtree.optional(),
}).refine(
  (record) =>
    record.request.workspaceMapping.kind === "native" ||
    (record.selectionActor?.kind === "account" &&
      record.selectionActor.subjectID === record.initiator &&
      record.selectionActor.orgID === record.orgID &&
      record.selectionActor.requestID === record.handoffID),
  "Object mappings require their original authenticated selection actor",
)
const RawStored = z.union([LegacyStored, Stored])
type Stored = z.infer<typeof Stored>
const key = (id: string) => ["organization", "handoffs", id]
const sessionKey = (sessionID: string) => ["organization", "session-handoffs", sessionID]
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
              ...(record.version === 2 ? [record.selectionActor] : []),
              ...(record.version === 2 && record.workspaceContract ? [record.workspaceContract] : []),
              ...(record.version === 2 && record.workspaceSource ? [record.workspaceSource] : []),
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
      Stored.parse(record)
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

  async function inspectionAccess(credentials: Credentials, sessionID: string, targetRuntimeID: string) {
    const access = await authorize(credentials, "session.read", { sessionID })
    await authorize(credentials, "project.execute", { projectID: access.session.projectID })
    const current = access.session
    if (current.handoffID) fail("HANDOFF_BLOCKED", "The current handoff already owns this Session")
    const [source, target] = await Promise.all([
      Record.read(Record.RuntimeRegistration, Keys.runtime(current.driverRuntimeID)),
      Record.read(Record.RuntimeRegistration, Keys.runtime(targetRuntimeID)),
    ])
    if (
      !source ||
      !target ||
      source.orgID !== current.orgID ||
      target.orgID !== current.orgID ||
      source.runtimeID === target.runtimeID
    )
      fail("NOT_FOUND", "Handoff destination is unavailable")
    if (access.account.accountID !== (source.runtimeKind === "member" ? source.accountID : current.creatorID))
      fail("PERMISSION_DENIED", "Only the current execution owner can inspect its handoff choices")
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
      missingRequirements,
      canCancel:
        !record.surrendered &&
        !["completed", "cancelled", "retired"].includes(record.phase) &&
        (!accountID || accountID === record.initiator),
      canAccept:
        record.phase === "preparing" &&
        !record.targetAccepted &&
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
    } else if (mapping.kind === "organization-live") {
      const selected = contract?.selection?.infrastructure.workspace
      if (
        !selected ||
        selected.resourceID !== mapping.resource.resourceID ||
        selected.workspaceID !== mapping.resource.workspaceID
      )
        fail("PROTOCOL_MISMATCH", "Live handoff must retain the Session's original Workspace resource")
      const catalog = await WorkspaceCatalog.get(
        selected.workspaceID,
        OrganizationCloud.scopeID(record.orgID, current.projectID),
      )
      if (catalog.activeMount || catalog.binding.generation !== mapping.resource.generation)
        fail("RESOURCE_UNAVAILABLE", "Live handoff requires its current dormant Workspace generation")
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

  async function save(record: Stored) {
    await Storage.write(key(record.handoffID), Stored.parse(record))
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
            choices.push({ kind: "organization-live", requiresDifference: false })
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
          if (mapping.kind === "organization-live") {
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
        !cancelled && mapping.kind === "organization-object" && record.workspaceContract
          ? {
              before: record.workspaceContract,
              after: OrganizationSessionResources.mappedWorkspace(record.workspaceContract, mapping.target),
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
        const access = await authorize(credentials, "session.read", { sessionID: record.sessionID })
        await authorize(credentials, "project.execute", { projectID: access.session.projectID })
        const role = Handoff.machineRole(request.operation)
        const required =
          role === "source"
            ? record.initiator
            : record.target.runtimeKind === "member"
              ? record.target.accountID
              : access.session.creatorID
        if (access.account.accountID !== required)
          fail("PERMISSION_DENIED", "This account cannot drive this handoff participant")
        const inspect = request.operation.startsWith("inspect-")
        if (!inspect) {
          if (request.operation === "cancel-source") {
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
                  targetScopeID:
                    record.request.workspaceMapping.kind !== "native"
                      ? OrganizationCloud.scopeID(record.orgID, access.session.projectID)
                      : undefined,
                }
              : undefined,
          purpose: "handoff-machine",
          keyID: options.signing.identity.keyID,
          runtimeID: runtime.runtimeID,
          connectionEpoch: connection.handshake.connectionEpoch,
          controlRevision: access.session.controlRevision,
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
          sourceBinding: {
            schemaVersion: 1,
            orgID: record.orgID,
            projectID: access.session.projectID,
            creatorID: access.session.creatorID,
            driverRuntimeID: record.sourceRuntimeID,
            bindingEpoch: record.fromEpoch,
          },
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
        return { authorization, connection }
      })
      const reply = await authorized.connection.exchange(
        { kind: "handoff", authorization: authorized.authorization },
        { signal: input.signal, deadline: authorized.authorization.plan.expiresAt },
      )
      authorized.connection.assertCurrent()
      if (reply.kind === "error") throw new OrganizationError(reply.error)
      if (reply.kind !== "handoff" || !Handoff.matchesMachine(authorized.authorization.plan, reply.result))
        fail("PROTOCOL_MISMATCH", "Handoff machine returned another operation")
      for (const fact of reply.result.facts) await api.proof(fact)
      await Storage.snapshot(async () => {
        const record = await load(handoffID)
        const access = await authorize(credentials, "session.read", { sessionID: record.sessionID })
        await authorize(credentials, "project.execute", { projectID: access.session.projectID })
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
            version: 2,
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
              request.workspaceMapping.kind === "organization-object"
                ? await OrganizationSessionResources.read(current)
                : undefined,
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
            if (request.workspaceMapping.kind === "organization-object" && files.handshake.schemas.handoffs < 2)
              fail("HANDOFF_BLOCKED", "Both participants must support complete mapped Workspace files")
            if (request.workspaceMapping.kind === "organization-live" && files.handshake.schemas.handoffs < 3)
              fail("HANDOFF_BLOCKED", "Both participants must support live Workspace source snapshots")
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
      return History.credentials(credentials, "handoff.accept", async () => {
        const record = await load(handoffID)
        const { account, session: current } = await authorize(credentials, "session.read", {
          sessionID: record.sessionID,
        })
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
        record.targetAccepted = true
        await save(record)
        return view(record, account.accountID)
      })
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
          if (mapping.kind === "organization-object") {
            if (!record.workspaceContract)
              fail("HANDOFF_BLOCKED", "Workspace mapping has no original resource contract")
            const move = workspaceRequest(record, allowed.current.projectID)!
            const receipt = await WorkspaceMove.validate(move)
            if (
              record.prepared.proof.purpose !== "target-prepared" ||
              record.prepared.proof.workspaceMoveReceiptHash !== WorkspaceMove.receiptHash(receipt)
            )
              fail("HANDOFF_BLOCKED", "Workspace mapping has no matching prepared CAS receipt")
            const mapped = await OrganizationSessionResources.rebindHandoff(
              allowed.current,
              record.workspaceContract,
              mapping.target,
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
          return view(current)
        }
        const directory = await session(current)
        if (directory.handoffID !== current.handoffID || ["completed", "cancelled", "retired"].includes(current.phase))
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
          if (current.version === 2 && current.request.workspaceMapping.kind === "organization-live") {
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
        } else {
          if (
            current.activated ||
            !current.surrendered ||
            !current.prepared ||
            proof.preparedHash !== (await Handoff.proofHash(current.prepared.proof))
          )
            fail("HANDOFF_BLOCKED", "Destination retirement requires its permanent never-activate proof")
          current.phase = "retired"
        }
        current[slot] = signed
        await save(current)
        return view(current)
      })
      if (["source-cancelled", "target-activated", "target-never-activate"].includes(signed.proof.purpose)) {
        const current = await Storage.snapshot(() => load(record.handoffID))
        const directory = await Storage.snapshot(() => session(current))
        const move = workspaceRequest(current, directory.projectID)
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
