import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationCommandProtocol as Command,
  OrganizationExecutionProtocol as Execution,
  OrganizationResourceProtocol as Resource,
  OrganizationHandoffProtocol as Handoff,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationSessionResources as Resources } from "./session-resources"
import { assertRuntimeConnection, runtimeAuthority } from "./runtime-authority"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail } from "./error"
import { projectView, projectExecutionRole } from "./authorization"
import type { CommandAdmissions } from "./command-admission"
import type { RuntimeConnections } from "./runtime-connection"
import type { createHandoffs } from "./handoff"
import { OrganizationAuthorityHistory as History } from "./authority-history"
import { isDeepStrictEqual as same } from "node:util"
import { OrganizationHandoffExecution } from "./handoff"
import { OrganizationExecutionIndex as Index } from "./execution-index"

async function saveGrant(grant: Execution.Grant) {
  await Storage.write(Keys.executionGrant(grant.grantID), grant)
  await Index.update(grant)
}

export namespace OrganizationExecutionGrants {
  export async function provision(session: Record.SessionDirectory, permit: Command.Permit) {
    if (!Storage.inTransaction()) fail("INVALID_REQUEST", "Execution grants must join command admission")
    if (
      permit.operation !== "input" ||
      permit.orgID !== session.orgID ||
      permit.sessionID !== session.sessionID ||
      permit.projectID !== session.projectID ||
      permit.runtimeID !== session.driverRuntimeID ||
      permit.bindingEpoch !== session.bindingEpoch
    )
      fail("PERMISSION_DENIED", "Execution admission does not match its Session")
    const contract = await Resources.read(session)
    if (!contract?.selection) return
    await Resources.enabled(session, contract.selection)
    const grant = Execution.Grant.parse({
      schemaVersion: 4,
      grantID: crypto.randomUUID(),
      orgID: session.orgID,
      deploymentIncarnation: permit.deploymentIncarnation,
      sessionID: session.sessionID,
      projectID: session.projectID,
      runtimeID: session.driverRuntimeID,
      bindingEpoch: session.bindingEpoch,
      selectionRevision: contract.revision,
      selection: contract.selection,
      limits: { requestBytes: 8 * 1024 * 1024, responseBytes: 16 * 1024 * 1024 },
      actor: permit.actor,
      admissionID: permit.admissionID,
      attemptID: permit.attemptID,
      createdAt: permit.authorizedAt,
      state: "provisional",
    })
    await saveGrant(grant)
    await Storage.write(
      Keys.session(session.sessionID),
      Record.SessionDirectory.parse({
        ...session,
        retainedExecutionGrants: session.retainedExecutionGrants + 1,
        rowRevision: session.rowRevision + 1,
      }),
    )
    return grant.grantID
  }
  export async function reject(permit: Command.Permit) {
    if (!permit.provisionalGrantID) return
    if (!Storage.inTransaction()) fail("INVALID_REQUEST", "Grant rejection must join command reconciliation")
    const grant = await Record.read(Record.ExecutionGrant, Keys.executionGrant(permit.provisionalGrantID))
    if (
      !grant ||
      grant.grantID !== permit.provisionalGrantID ||
      grant.attemptID !== permit.attemptID ||
      grant.admissionID !== permit.admissionID ||
      grant.sessionID !== permit.sessionID ||
      grant.orgID !== permit.orgID
    )
      fail("PROTOCOL_MISMATCH", "Command execution grant does not match its admission")
    if (grant.state === "closed") return
    if (grant.state === "bound") fail("PROTOCOL_MISMATCH", "An accepted root grant cannot be rejected")
    const session = await Record.read(Record.SessionDirectory, Keys.session(grant.sessionID))
    if (!session || session.orgID !== grant.orgID) fail("NOT_FOUND", "Session not found")
    await saveGrant(Execution.Grant.parse({ ...grant, state: "closed", closedAt: Date.now() }))
    await Storage.write(
      Keys.session(session.sessionID),
      Record.SessionDirectory.parse({
        ...session,
        retainedExecutionGrants: session.retainedExecutionGrants - 1,
        rowRevision: session.rowRevision + 1,
      }),
    )
  }
}

type ReceiptProof =
  | Execution.BindingProof
  | Execution.DescriptionProof
  | Execution.ReleaseProof
  | Execution.HandoffCloseProof
  | Execution.InspectionProof
type MachineProof = Pick<
  Execution.DescriptionProof,
  "orgID" | "deploymentIncarnation" | "runtimeID" | "connectionEpoch" | "issuedAt" | "expiresAt"
>

export function createExecutionGrants(options: {
  connections: RuntimeConnections
  admissions: CommandAdmissions
  assertResourcesDrained(grantID: string): void
  handoffs?: Pick<ReturnType<typeof createHandoffs>, "executionAuthority" | "continuationAuthority">
}) {
  function window(proof: MachineProof) {
    if (proof.issuedAt > Date.now() || proof.expiresAt <= Date.now())
      fail("PERMISSION_DENIED", "Execution binding proof is outside its validity window")
  }
  async function machine(proof: MachineProof) {
    return runtimeAuthority(proof)
  }
  function capture(proof: MachineProof, runtime: Record.RuntimeRegistration) {
    const connection = options.connections.capture(proof.runtimeID)
    assertRuntimeConnection(runtime, connection.handshake)
    return connection
  }
  async function original(proof: ReceiptProof) {
    const accepted = proof.receipt.accepted!
    const permit = accepted.permit
    const request = await Record.read(
      Record.CommandRequest,
      Keys.commandRequest(permit.actor.subjectID, permit.requestID),
    )
    if (!request?.accepted || !same(request.accepted, accepted))
      fail("PERMISSION_DENIED", "Execution continuation has no original service acceptance")
    return accepted
  }
  async function prepareContinuation(proof: Execution.DescriptionProof | Execution.BindingProof, publicKey: string) {
    const continuation = proof.continuation
    const control = continuation?.receipt.accepted
    if (!continuation || !control || control.effect.operation !== "continue" || !control.effect.rootID) return
    const rootID = control.effect.rootID
    const connection = capture(proof, (await Storage.snapshot(() => machine(proof))).runtime)
    if (!options.handoffs) fail("HANDOFF_BLOCKED", "Execution continuation authority is unavailable")
    const handoffs = options.handoffs
    let predecessorID: string | undefined
    await History.system(
      "execution.handoff.continue",
      async (identify, actionID) => {
        identify({ ...control.permit.actor, requestID: actionID })
        window(proof)
        connection.assertCurrent()
        const { runtime } = await machine(proof)
        if (runtime.publicKey !== publicKey) fail("PERMISSION_DENIED", "Execution continuation identity changed")
        const accepted = await original(proof)
        const permit = accepted.permit
        const authority = await handoffs.continuationAuthority({
          handoffID: continuation.handoffID,
          sessionID: permit.sessionID,
          runtimeID: proof.runtimeID,
          bindingEpoch: control.permit.bindingEpoch,
          commandSeq: control.permit.commandSeq,
        })
        const session = authority.current
        const currentKey = Keys.rootGrant(session.sessionID, session.bindingEpoch, rootID)
        const pointer = await Record.read(Record.RootGrant, currentKey)
        const source =
          pointer ??
          (await Record.read(Record.RootGrant, Keys.rootGrant(session.sessionID, authority.sourceBindingEpoch, rootID)))
        const predecessor = await Record.read(
          Record.ExecutionGrant,
          Keys.executionGrant(source?.grantID ?? permit.provisionalGrantID!),
        )
        if (
          !predecessor ||
          predecessor.sessionID !== permit.sessionID ||
          predecessor.orgID !== permit.orgID ||
          predecessor.projectID !== permit.projectID ||
          predecessor.admissionID !== permit.admissionID ||
          predecessor.attemptID !== permit.attemptID ||
          !same(predecessor.actor, permit.actor) ||
          (predecessor.state === "bound" && predecessor.rootID !== rootID) ||
          (predecessor.provenance && predecessor.provenance.originGrantID !== permit.provisionalGrantID)
        )
          fail("PERMISSION_DENIED", "Execution continuation has another original task grant")
        if (
          predecessor.runtimeID !== (pointer ? session.driverRuntimeID : authority.sourceRuntimeID) ||
          predecessor.bindingEpoch !== (pointer ? session.bindingEpoch : authority.sourceBindingEpoch)
        )
          fail("PERMISSION_DENIED", "Execution continuation predecessor has another native binding")
        if (
          pointer &&
          predecessor.provenance?.handoffID === continuation.handoffID &&
          same(predecessor.provenance.control, control)
        )
          return
        if (predecessor.provenance && control.permit.commandSeq <= predecessor.provenance.control.permit.commandSeq)
          fail("PERMISSION_DENIED", "Execution continuation cannot reuse an older control")
        const priorClosed =
          predecessor.state === "bound" && predecessor.retention.state === "handoff_closed"
            ? predecessor.retention
            : predecessor.state === "closed"
              ? predecessor.handoffClosure
              : undefined
        const retainedSource =
          authority.cancelled &&
          predecessor.runtimeID === session.driverRuntimeID &&
          predecessor.bindingEpoch === session.bindingEpoch &&
          (predecessor.state === "provisional" ||
            (predecessor.state === "bound" && predecessor.retention.state === "held"))
        const completedSource =
          predecessor.runtimeID === authority.sourceRuntimeID &&
          predecessor.bindingEpoch === authority.sourceBindingEpoch &&
          predecessor.state === "bound" &&
          predecessor.retention.state === "released"
        if (
          (!pointer || !predecessor.provenance) &&
          priorClosed?.handoffID !== continuation.handoffID &&
          !retainedSource &&
          !completedSource
        )
          fail("HANDOFF_BLOCKED", "Execution continuation requires its source generation closure")
        if (predecessor.state === "bound" && predecessor.retention.state === "control_closed")
          fail("PERMISSION_DENIED", "Execution continuation pointer has already been superseded")
        const held =
          predecessor.state === "provisional" ||
          (predecessor.state === "bound" && predecessor.retention.state === "held")
        if (held && !session.retainedExecutionGrants)
          fail("PROTOCOL_MISMATCH", "Retained execution count is inconsistent")
        options.assertResourcesDrained(predecessor.grantID)
        predecessorID = predecessor.grantID
        const contract = await Resources.read(session)
        if (
          !contract ||
          contract.revision !== predecessor.selectionRevision ||
          !same(contract.selection, predecessor.selection)
        )
          fail("REVISION_CONFLICT", "Execution continuation resource selection changed")
        await Resources.enabled(session, predecessor.selection)
        const grant = Execution.Grant.parse({
          schemaVersion: 4,
          state: "provisional",
          grantID: crypto.randomUUID(),
          orgID: predecessor.orgID,
          deploymentIncarnation: predecessor.deploymentIncarnation,
          sessionID: predecessor.sessionID,
          projectID: predecessor.projectID,
          selectionRevision: predecessor.selectionRevision,
          selection: predecessor.selection,
          limits: predecessor.limits,
          actor: predecessor.actor,
          admissionID: predecessor.admissionID,
          attemptID: predecessor.attemptID,
          runtimeID: session.driverRuntimeID,
          bindingEpoch: session.bindingEpoch,
          createdAt: Date.now(),
          provenance: {
            handoffID: continuation.handoffID,
            predecessorGrantID: predecessor.grantID,
            originGrantID: permit.provisionalGrantID,
            rootID,
            control,
          },
        })
        if (held && predecessor.state === "bound")
          await saveGrant(
            Execution.Grant.parse({
              ...predecessor,
              retention: {
                state: "control_closed",
                generation: predecessor.retention.generation,
                successorGrantID: grant.grantID,
                closedAt: Date.now(),
              },
            }),
          )
        if (held && predecessor.state === "provisional")
          await saveGrant(
            Execution.Grant.parse({
              ...predecessor,
              state: "closed",
              closedAt: Date.now(),
              controlClosure: { rootID, successorGrantID: grant.grantID, closedAt: Date.now() },
            }),
          )
        await saveGrant(grant)
        await Storage.write(currentKey, Record.RootGrant.parse({ grantID: grant.grantID }))
        await Storage.write(
          Keys.session(session.sessionID),
          Record.SessionDirectory.parse({
            ...session,
            retainedExecutionGrants: session.retainedExecutionGrants + (held ? 0 : 1),
            rowRevision: session.rowRevision + 1,
          }),
        )
      },
      {
        commitGuard() {
          window(proof)
          connection.assertCurrent()
          if (predecessorID) options.assertResourcesDrained(predecessorID)
        },
      },
    )
  }
  function receivedGrant(
    proof: ReceiptProof,
    value: Execution.Grant | undefined,
    access: "execution" | "retention" = "execution",
  ): Execution.Grant {
    const accepted = proof.receipt.accepted!
    const permit = accepted.permit
    const control = proof.continuation?.receipt.accepted
    if (
      !value ||
      (!control && value.grantID !== permit.provisionalGrantID) ||
      value.orgID !== permit.orgID ||
      value.deploymentIncarnation !== permit.deploymentIncarnation ||
      value.sessionID !== permit.sessionID ||
      value.projectID !== permit.projectID ||
      value.runtimeID !== (control?.permit.runtimeID ?? permit.runtimeID) ||
      value.bindingEpoch !== (control?.permit.bindingEpoch ?? permit.bindingEpoch) ||
      value.attemptID !== permit.attemptID ||
      value.admissionID !== permit.admissionID ||
      (value.state === "bound" && value.rootID !== accepted.effect.messageID) ||
      JSON.stringify(value.actor) !== JSON.stringify(permit.actor)
    )
      fail("PERMISSION_DENIED", "Execution grant does not match the accepted admission")
    if (
      control &&
      (!value.provenance ||
        value.provenance.originGrantID !== permit.provisionalGrantID ||
        !same(value.provenance.control, control))
    )
      fail("PERMISSION_DENIED", "Execution grant has another independent control provenance")
    if (control && value.provenance?.handoffID !== proof.continuation?.handoffID) {
      const closed =
        value.state === "bound" && value.retention.state === "handoff_closed"
          ? value.retention
          : value.state === "closed"
            ? value.handoffClosure
            : undefined
      if (access !== "retention" || closed?.handoffID !== proof.continuation?.handoffID)
        fail("PERMISSION_DENIED", "Execution continuation has another permanent handoff origin")
    }
    return value
  }
  async function ownedSession(proof: ReceiptProof, publicKey: string) {
    const { runtime, account } = await machine(proof)
    if (runtime.publicKey !== publicKey) fail("PERMISSION_DENIED", "Execution binding identity changed")
    const accepted = proof.receipt.accepted!
    const permit = accepted.permit
    const control = proof.continuation?.receipt.accepted
    const session = await Record.read(Record.SessionDirectory, Keys.session(permit.sessionID))
    if (
      !session ||
      session.sessionID !== permit.sessionID ||
      session.orgID !== proof.orgID ||
      session.projectID !== permit.projectID ||
      session.driverRuntimeID !== runtime.runtimeID ||
      session.bindingEpoch !== (control?.permit.bindingEpoch ?? permit.bindingEpoch)
    )
      fail("STALE_BINDING", "Execution grant Session binding changed")
    await original(proof)
    if (control) {
      const request = await Record.read(
        Record.CommandRequest,
        Keys.commandRequest(control.permit.actor.subjectID, control.permit.requestID),
      )
      if (!same(request?.accepted, control))
        fail("PERMISSION_DENIED", "Execution control does not match canonical acceptance")
    }
    return { session, runtime, account }
  }
  async function resolve(
    proof: ReceiptProof,
    publicKey: string,
    access: "execution" | "retention" = "execution",
    selector?: string,
  ) {
    const { session, account } = await ownedSession(proof, publicKey)
    const accepted = proof.receipt.accepted!
    const permit = accepted.permit
    const control = proof.continuation?.receipt.accepted
    const continued =
      control &&
      (await Record.read(
        Record.RootGrant,
        Keys.rootGrant(session.sessionID, session.bindingEpoch, accepted.effect.messageID),
      ))
    const grant = await Record.read(
      Record.ExecutionGrant,
      Keys.executionGrant(selector ?? (continued ? continued.grantID : permit.provisionalGrantID!)),
    )
    if (
      selector &&
      (!grant ||
        grant.grantID !== selector ||
        (control
          ? grant.provenance?.control.permit.admissionID !== control.permit.admissionID
          : grant.grantID !== permit.provisionalGrantID))
    )
      fail("PROTOCOL_MISMATCH", "Execution release does not identify its canonical grant")
    const retained = receivedGrant(proof, grant, access)
    return { session, grant: retained, account }
  }
  async function enabled(
    session: Record.SessionDirectory,
    grant: Execution.Grant,
    account: Record.Account | undefined,
  ) {
    await OrganizationHandoffExecution.assertExecution(session, grant)
    if (grant.state === "closed") fail("PERMISSION_DENIED", "Execution grant is closed")
    if (grant.state === "bound" && grant.retention.state === "handoff_closed")
      fail("PERMISSION_DENIED", "Execution grant was closed for handoff")
    if (grant.provenance && grant.state === "bound" && grant.retention.state !== "held")
      fail("PERMISSION_DENIED", "Execution continuation requires a new independent control")
    if ((grant.state === "provisional" || grant.retention.state === "held") && session.retainedExecutionGrants === 0)
      fail("PROTOCOL_MISMATCH", "Retained execution grant count is inconsistent")
    const [project, membership] = await Promise.all([
      Record.read(Record.Project, Keys.project(session.projectID)),
      account ? Record.read(Record.ProjectMember, Keys.projectMember(session.projectID, account.accountID)) : undefined,
    ])
    if (!project) fail("NOT_FOUND", "Project not found")
    if (account && !projectExecutionRole(projectView(account, project, membership, "project.read").role))
      fail("PERMISSION_DENIED", "Runtime account cannot execute project work")
    const contract = await Resources.read(session)
    if (
      !contract ||
      contract.revision !== grant.selectionRevision ||
      JSON.stringify(contract.selection) !== JSON.stringify(grant.selection)
    )
      fail("REVISION_CONFLICT", "Session resource selection changed")
    return Resources.enabled(session, grant.selection)
  }
  async function retention(value: Execution.DescriptionRequest): Promise<Execution.Grant>
  async function retention(value: Execution.InspectionRequest): Promise<Execution.Inspection>
  async function retention(value: Execution.RetentionRequest): Promise<Execution.RetentionResult>
  async function retention(value: Execution.RetentionRequest): Promise<Execution.RetentionResult> {
    if (Storage.inTransaction()) fail("INVALID_REQUEST", "Retention inspection must own its reconciliation boundary")
    const request = Execution.RetentionRequest.parse(value)
    if (request.proof.purpose === "execution-retention-inspection")
      return inspectRetention(Execution.InspectionRequest.parse(request))
    const { proof, signature } = Execution.DescriptionRequest.parse(request)
    window(proof)
    const registered = await Storage.snapshot(() => machine(proof))
    if (!(await Execution.verifyDescription(proof, signature, registered.runtime.publicKey)))
      fail("PERMISSION_DENIED", "Execution retention proof signature is invalid")
    const connection = capture(proof, registered.runtime)
    await options.admissions.observe(connection, proof.continuation?.receipt ?? proof.receipt)
    return Storage.snapshot(async () => {
      const { grant } = await resolve(proof, registered.runtime.publicKey, "retention")
      window(proof)
      connection.assertCurrent()
      return grant
    })
  }
  async function inspectRetention(value: Execution.InspectionRequest): Promise<Execution.Inspection> {
    const { proof, signature } = Execution.InspectionRequest.parse(value)
    window(proof)
    const registered = await Storage.snapshot(() => machine(proof))
    if (!(await Execution.verifyInspection(proof, signature, registered.runtime.publicKey)))
      fail("PERMISSION_DENIED", "Execution cleanup inspection signature is invalid")
    const connection = capture(proof, registered.runtime)
    await options.admissions.observe(connection, proof.continuation?.receipt ?? proof.receipt)
    return Storage.snapshot(async () => {
      const { session } = await ownedSession(proof, registered.runtime.publicKey)
      const accepted = proof.receipt.accepted!
      const control = proof.continuation?.receipt.accepted
      const envelope = {
        schemaVersion: 1,
        orgID: proof.orgID,
        deploymentIncarnation: proof.deploymentIncarnation,
        runtimeID: proof.runtimeID,
        connectionEpoch: proof.connectionEpoch,
        sessionID: session.sessionID,
        bindingEpoch: session.bindingEpoch,
        rootID: proof.rootID,
        originGrantID: accepted.permit.provisionalGrantID!,
        controlAdmissionID: control?.permit.admissionID,
        requestedGrantID: proof.grantID,
        requestedGeneration: proof.generation,
        inspectedAt: Date.now(),
      }
      let grantID = proof.grantID ?? accepted.permit.provisionalGrantID!
      if (proof.grantID === undefined && control) {
        const located = await Index.control(session.sessionID, session.bindingEpoch, control.permit.admissionID)
        if (located === undefined) {
          const origin = await Record.read(
            Record.ExecutionGrant,
            Keys.executionGrant(accepted.permit.provisionalGrantID!),
          )
          if (
            !origin ||
            origin.grantID !== accepted.permit.provisionalGrantID ||
            origin.orgID !== proof.orgID ||
            origin.deploymentIncarnation !== proof.deploymentIncarnation ||
            origin.sessionID !== session.sessionID ||
            origin.projectID !== session.projectID ||
            origin.admissionID !== accepted.permit.admissionID ||
            origin.attemptID !== accepted.permit.attemptID ||
            !same(origin.actor, accepted.permit.actor)
          )
            fail("SERVICE_UNAVAILABLE", "Cleanup absence lacks its canonical original grant")
          const pointer = await Record.read(
            Record.RootGrant,
            Keys.rootGrant(session.sessionID, session.bindingEpoch, proof.rootID),
          )
          if (pointer) {
            const current = await Record.read(Record.ExecutionGrant, Keys.executionGrant(pointer.grantID))
            if (
              !current ||
              current.grantID !== pointer.grantID ||
              current.sessionID !== session.sessionID ||
              current.bindingEpoch !== session.bindingEpoch ||
              current.orgID !== proof.orgID ||
              current.deploymentIncarnation !== proof.deploymentIncarnation ||
              current.runtimeID !== proof.runtimeID ||
              (current.state === "bound" ? current.rootID : current.provenance?.rootID) !== proof.rootID ||
              current.provenance?.control.permit.admissionID === control.permit.admissionID
            )
              fail("SERVICE_UNAVAILABLE", "Execution control locator does not cover its canonical root grant")
          }
          window(proof)
          connection.assertCurrent()
          return Execution.Inspection.parse({ ...envelope, state: "absent" })
        }
        grantID = located
      }
      const stored = await Record.read(Record.ExecutionGrant, Keys.executionGrant(grantID))
      if (!stored) fail(proof.grantID ? "NOT_FOUND" : "SERVICE_UNAVAILABLE", "Selected execution grant is unavailable")
      const grant = receivedGrant(proof, stored, "retention")
      const rootID =
        grant.state === "bound"
          ? grant.rootID
          : (grant.provenance?.rootID ??
            (grant.state === "closed" ? (grant.handoffClosure?.rootID ?? grant.controlClosure?.rootID) : undefined) ??
            accepted.effect.messageID)
      if (grant.grantID !== grantID || rootID !== proof.rootID)
        fail("PROTOCOL_MISMATCH", "Selected grant belongs to another original task root")
      const generation = grant.state === "bound" ? grant.retention.generation : 0
      if (proof.generation !== undefined && proof.generation > generation)
        fail("REVISION_CONFLICT", "Selected retention generation has not been created")
      const release =
        proof.generation === undefined
          ? undefined
          : await Record.read(Record.ExecutionRelease, Keys.executionRelease(grant.grantID, proof.generation))
      window(proof)
      connection.assertCurrent()
      return Execution.Inspection.parse({ ...envelope, state: "known", grant, release })
    })
  }
  return {
    retention,
    async handoffInventory(value: Execution.HandoffInventoryRequest) {
      if (Storage.inTransaction()) fail("INVALID_REQUEST", "Handoff inventory must own its read boundary")
      const { proof, signature } = Execution.HandoffInventoryRequest.parse(value)
      window(proof)
      const registered = await Storage.snapshot(() => runtimeAuthority(proof))
      if (!(await Execution.verifyHandoffInventory(proof, signature, registered.runtime.publicKey)))
        fail("PERMISSION_DENIED", "Handoff inventory signature is invalid")
      const connection = capture(proof, registered.runtime)
      if (!options.handoffs) fail("HANDOFF_BLOCKED", "Handoff inventory authority is unavailable")
      const handoffs = options.handoffs
      const page = await Storage.snapshot(async () => {
        const authority = await handoffs.executionAuthority(proof)
        const session = authority.current
        const entries = await Index.page(session, { after: proof.cursor, limit: 64 })
        const items = []
        for (const entry of entries) {
          const grant = await Record.read(Record.ExecutionGrant, Keys.executionGrant(entry.grantID))
          if (
            !grant ||
            grant.grantID !== entry.grantID ||
            grant.orgID !== session.orgID ||
            grant.sessionID !== session.sessionID ||
            grant.runtimeID !== proof.sourceRuntimeID ||
            grant.bindingEpoch !== proof.fromEpoch ||
            !(grant.state === "provisional" || (grant.state === "bound" && grant.retention.state === "held"))
          )
            fail("SERVICE_UNAVAILABLE", "Retained grant index has another canonical owner or state")
          const request = await Record.read(
            Record.CommandRequest,
            Keys.commandRequest(grant.actor.subjectID, grant.actor.requestID),
          )
          const accepted = request?.accepted
          if (
            !accepted ||
            accepted.effect.kind !== "inbox" ||
            accepted.effect.mode !== "task" ||
            accepted.permit.sessionID !== session.sessionID ||
            !same(accepted.permit.actor, grant.actor) ||
            accepted.permit.provisionalGrantID !== (grant.provenance?.originGrantID ?? grant.grantID)
          )
            fail("HANDOFF_BLOCKED", "Reconcile the original accepted task before closing its source resources")
          const rootID =
            grant.state === "bound" ? grant.rootID : (grant.provenance?.rootID ?? accepted.effect.messageID)
          if (rootID !== accepted.effect.messageID)
            fail("PROTOCOL_MISMATCH", "Retained resource root does not match its original task")
          items.push(
            Execution.HandoffInventoryItem.parse({
              grantID: grant.grantID,
              rootID,
              generation: grant.state === "bound" ? grant.retention.generation : 0,
              originGrantID: grant.provenance?.originGrantID ?? grant.grantID,
              lookup: { subjectID: grant.actor.subjectID, requestID: grant.actor.requestID },
              continuation: grant.provenance
                ? {
                    handoffID: grant.provenance.handoffID,
                    lookup: {
                      subjectID: grant.provenance.control.permit.actor.subjectID,
                      requestID: grant.provenance.control.permit.requestID,
                    },
                  }
                : undefined,
            }),
          )
        }
        window(proof)
        connection.assertCurrent()
        authority.guard()
        return Execution.HandoffInventoryPage.parse({
          binding: Handoff.Binding.strip().parse(proof),
          retained: session.retainedExecutionGrants,
          items,
          ...(entries.length === 64 ? { cursor: entries.at(-1)!.grantID } : {}),
        })
      })
      await Storage.snapshot(async () => {
        const current = await handoffs.executionAuthority(proof)
        window(proof)
        connection.assertCurrent()
        current.guard()
      })
      return page
    },
    async closeHandoff(value: Execution.HandoffCloseRequest): Promise<Execution.HandoffCloseReceipt> {
      if (Storage.inTransaction()) fail("INVALID_REQUEST", "Handoff resource closure must own its commit boundary")
      const { proof, signature } = Execution.HandoffCloseRequest.parse(value)
      window(proof)
      const registered = await Storage.snapshot(() => machine(proof))
      if (!(await Execution.verifyHandoffClose(proof, signature, registered.runtime.publicKey)))
        fail("PERMISSION_DENIED", "Handoff resource closure signature is invalid")
      const connection = capture(proof, registered.runtime)
      await options.admissions.observe(connection, proof.continuation?.receipt ?? proof.receipt)
      const key = ["organization", "execution-handoff-closures", proof.grantID, String(proof.generation)]
      let guard: (() => void) | undefined
      return History.system(
        "execution.handoff.close",
        async (identify, actionID) => {
          identify({
            kind: "system",
            orgID: proof.orgID,
            subjectID: proof.runtimeID,
            displayName: "Runtime",
            clientKind: "runtime",
            requestID: actionID,
          })
          window(proof)
          connection.assertCurrent()
          const [raw] = await Storage.readMany([key])
          const previous = raw === undefined ? undefined : Execution.HandoffCloseReceipt.parse(raw)
          const receipt = Execution.HandoffCloseReceipt.strip().parse({
            ...proof,
            purpose: "execution-handoff-closed",
            closedAt: previous?.closedAt ?? Date.now(),
          })
          if (previous) {
            if (JSON.stringify(previous) !== JSON.stringify(receipt))
              fail("REVISION_CONFLICT", "Handoff closure already has another cause")
            await original(proof)
            const historical = receivedGrant(
              proof,
              await Record.read(Record.ExecutionGrant, Keys.executionGrant(proof.grantID)),
            )
            if (historical.grantID !== proof.grantID)
              fail("PROTOCOL_MISMATCH", "Handoff closure receipt has another canonical grant")
            return previous
          }
          if (!options.handoffs) fail("HANDOFF_BLOCKED", "Handoff resource authority is unavailable")
          const authority = await options.handoffs.executionAuthority(proof)
          guard = authority.guard
          const { session, grant } = await resolve(proof, registered.runtime.publicKey)
          if (
            grant.grantID !== proof.grantID ||
            grant.runtimeID !== proof.sourceRuntimeID ||
            grant.bindingEpoch !== proof.fromEpoch
          )
            fail("PERMISSION_DENIED", "Handoff closure has another original grant")
          if (
            grant.state === "closed" ||
            (grant.state === "bound" &&
              (grant.rootID !== proof.rootID ||
                grant.retention.state !== "held" ||
                grant.retention.generation !== proof.generation))
          )
            fail("REVISION_CONFLICT", "Handoff source retention generation changed")
          if (grant.state === "provisional" && proof.generation !== 0)
            fail("REVISION_CONFLICT", "Unbound source grant has another generation")
          if (!session.retainedExecutionGrants)
            fail("PROTOCOL_MISMATCH", "Retained execution grant count is inconsistent")
          options.assertResourcesDrained(grant.grantID)
          const closure = {
            handoffID: proof.handoffID,
            manifestHash: proof.manifestHash,
            preparedHash: proof.preparedHash,
            closedAt: receipt.closedAt,
          }
          await saveGrant(
            Execution.Grant.parse(
              grant.state === "bound"
                ? { ...grant, retention: { ...closure, state: "handoff_closed", generation: proof.generation } }
                : {
                    ...grant,
                    state: "closed",
                    closedAt: receipt.closedAt,
                    handoffClosure: { ...closure, rootID: proof.rootID, generation: 0 },
                  },
            ),
          )
          await Storage.write(
            Keys.session(session.sessionID),
            Record.SessionDirectory.parse({
              ...session,
              retainedExecutionGrants: session.retainedExecutionGrants - 1,
              rowRevision: session.rowRevision + 1,
            }),
          )
          await Storage.write(key, receipt)
          return receipt
        },
        {
          commitGuard() {
            window(proof)
            connection.assertCurrent()
            guard?.()
            options.assertResourcesDrained(proof.grantID)
          },
        },
      )
    },
    async describe(value: Execution.DescriptionRequest): Promise<Execution.Description> {
      if (Storage.inTransaction()) fail("INVALID_REQUEST", "Resource description must own its reconciliation boundary")
      const { proof, signature } = Execution.DescriptionRequest.parse(value)
      window(proof)
      const registered = await Storage.snapshot(() => machine(proof))
      if (!(await Execution.verifyDescription(proof, signature, registered.runtime.publicKey)))
        fail("PERMISSION_DENIED", "Execution resource proof signature is invalid")
      const connection = capture(proof, registered.runtime)
      await options.admissions.observe(connection, proof.continuation?.receipt ?? proof.receipt)
      await prepareContinuation(proof, registered.runtime.publicKey)
      return Storage.snapshot(async () => {
        const { session, grant, account } = await resolve(proof, registered.runtime.publicKey)
        const resources = await enabled(session, grant, account)
        window(proof)
        connection.assertCurrent()
        return Execution.Description.parse({
          grant,
          resources: resources.map((resource) => {
            const definition = Resource.definition(resource.configuration)
            return { resourceID: resource.resourceID, revision: resource.revision, name: resource.name, definition }
          }),
        })
      })
    },
    async bind(value: Execution.BindingRequest): Promise<Execution.BoundGrant> {
      if (Storage.inTransaction()) fail("INVALID_REQUEST", "Execution binding must own its commit boundary")
      const { proof, signature } = Execution.BindingRequest.parse(value)
      window(proof)
      const registered = await Storage.snapshot(() => machine(proof))
      if (!(await Execution.verifyBinding(proof, signature, registered.runtime.publicKey)))
        fail("PERMISSION_DENIED", "Execution binding signature is invalid")
      const connection = capture(proof, registered.runtime)
      await options.admissions.observe(connection, proof.continuation?.receipt ?? proof.receipt)
      await prepareContinuation(proof, registered.runtime.publicKey)
      return Storage.transaction(
        async () => {
          window(proof)
          connection.assertCurrent()
          const { session, grant, account } = await resolve(proof, registered.runtime.publicKey)
          await enabled(session, grant, account)
          const key = Keys.rootGrant(session.sessionID, session.bindingEpoch, proof.rootID)
          const previous = await Record.read(Record.RootGrant, key)
          if (previous && previous.grantID !== grant.grantID)
            fail("REVISION_CONFLICT", "Root already has a different execution grant")
          if (grant.state === "bound") {
            if (grant.rootID !== proof.rootID || !previous)
              fail("PROTOCOL_MISMATCH", "Execution root binding is inconsistent")
            if (grant.retention.state === "held") return grant
            const retained = Execution.BoundGrant.parse({
              ...grant,
              retention: { state: "held", generation: grant.retention.generation + 1 },
            })
            await saveGrant(retained)
            await Storage.write(
              Keys.session(session.sessionID),
              Record.SessionDirectory.parse({
                ...session,
                retainedExecutionGrants: session.retainedExecutionGrants + 1,
                rowRevision: session.rowRevision + 1,
              }),
            )
            return retained
          }
          const bound = Execution.BoundGrant.parse({
            ...grant,
            state: "bound",
            rootID: proof.rootID,
            boundAt: Date.now(),
            retention: { state: "held", generation: 1 },
          })
          await saveGrant(bound)
          await Storage.write(key, Record.RootGrant.parse({ grantID: grant.grantID }))
          return bound
        },
        {
          commitGuard() {
            window(proof)
            connection.assertCurrent()
          },
        },
      )
    },
    async release(value: Execution.ReleaseRequest): Promise<Execution.ReleaseReceipt> {
      if (Storage.inTransaction()) fail("INVALID_REQUEST", "Execution release must own its commit boundary")
      const { proof, signature } = Execution.ReleaseRequest.parse(value)
      window(proof)
      const registered = await Storage.snapshot(() => machine(proof))
      if (!(await Execution.verifyRelease(proof, signature, registered.runtime.publicKey)))
        fail("PERMISSION_DENIED", "Execution release signature is invalid")
      const connection = capture(proof, registered.runtime)
      await options.admissions.observe(connection, proof.continuation?.receipt ?? proof.receipt)
      let releasingGrantID: string | undefined
      return Storage.transaction(
        async () => {
          window(proof)
          connection.assertCurrent()
          const { session, grant } = await resolve(proof, registered.runtime.publicKey, "execution", proof.grantID)
          if (proof.grantID !== undefined && proof.grantID !== grant.grantID)
            fail("PROTOCOL_MISMATCH", "Execution release does not identify its canonical grant")
          const key = Keys.executionRelease(grant.grantID, proof.generation)
          const previous = await Record.read(Record.ExecutionRelease, key)
          const receipt = Execution.ReleaseReceipt.parse({
            schemaVersion: 1,
            orgID: grant.orgID,
            deploymentIncarnation: grant.deploymentIncarnation,
            runtimeID: grant.runtimeID,
            sessionID: grant.sessionID,
            bindingEpoch: grant.bindingEpoch,
            grantID: grant.grantID,
            rootID: proof.rootID,
            generation: proof.generation,
            outcome: proof.outcome,
            materialized: proof.materialized,
            releasedAt: previous?.releasedAt ?? Date.now(),
          })
          if (previous) {
            if (JSON.stringify(previous) !== JSON.stringify(receipt))
              fail("REVISION_CONFLICT", "Execution release already has different evidence")
            return previous
          }
          if (grant.state === "closed") fail("PERMISSION_DENIED", "Execution grant is closed")
          if (grant.state === "bound") {
            const root = await Record.read(
              Record.RootGrant,
              Keys.rootGrant(session.sessionID, session.bindingEpoch, proof.rootID),
            )
            if (grant.rootID !== proof.rootID || root?.grantID !== grant.grantID)
              fail("PROTOCOL_MISMATCH", "Execution release root binding is inconsistent")
            if (grant.retention.state !== "held" || grant.retention.generation !== proof.generation)
              fail("REVISION_CONFLICT", "Execution retention generation changed")
          } else if (proof.generation !== 0) fail("REVISION_CONFLICT", "Execution grant has not been bound")
          else if (proof.outcome !== "cancelled" && !proof.materialized)
            fail("RESOURCE_UNAVAILABLE", "Unbound execution release lacks materialized root evidence")
          if (session.retainedExecutionGrants === 0)
            fail("PROTOCOL_MISMATCH", "Retained execution grant count is inconsistent")
          options.assertResourcesDrained(grant.grantID)
          releasingGrantID = grant.grantID
          await saveGrant(
            Execution.Grant.parse(
              grant.state === "bound"
                ? {
                    ...grant,
                    retention: {
                      state: "released",
                      generation: proof.generation,
                      outcome: proof.outcome,
                      releasedAt: receipt.releasedAt,
                    },
                  }
                : { ...grant, state: "closed", closedAt: receipt.releasedAt },
            ),
          )
          await Storage.write(
            Keys.session(session.sessionID),
            Record.SessionDirectory.parse({
              ...session,
              retainedExecutionGrants: session.retainedExecutionGrants - 1,
              rowRevision: session.rowRevision + 1,
            }),
          )
          await Storage.write(key, receipt)
          return receipt
        },
        {
          commitGuard() {
            window(proof)
            connection.assertCurrent()
            if (releasingGrantID) options.assertResourcesDrained(releasingGrantID)
          },
        },
      )
    },
  }
}
export type ExecutionGrants = ReturnType<typeof createExecutionGrants>
