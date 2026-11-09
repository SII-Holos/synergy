import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationCommandProtocol as Command,
  OrganizationExecutionProtocol as Execution,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationSessionResources as Resources } from "./session-resources"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail } from "./error"
import { projectView, projectExecutionRole } from "./authorization"
import type { CommandAdmissions } from "./command-admission"
import type { RuntimeConnections } from "./runtime-connection"

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
    if (session.executionGrantIDs.length >= 64)
      fail("RESOURCE_UNAVAILABLE", "Session execution grant capacity is occupied")
    await Resources.enabled(session, contract.selection)
    const grant = Execution.Grant.parse({
      schemaVersion: 1,
      grantID: crypto.randomUUID(),
      orgID: session.orgID,
      deploymentIncarnation: permit.deploymentIncarnation,
      sessionID: session.sessionID,
      projectID: session.projectID,
      runtimeID: session.driverRuntimeID,
      bindingEpoch: session.bindingEpoch,
      selectionRevision: contract.revision,
      selection: contract.selection,
      limits: { calls: 1024, requestBytes: 8 * 1024 * 1024, responseBytes: 16 * 1024 * 1024 },
      actor: permit.actor,
      admissionID: permit.admissionID,
      attemptID: permit.attemptID,
      createdAt: permit.authorizedAt,
      state: "provisional",
    })
    await Storage.write(Keys.executionGrant(grant.grantID), grant)
    await Storage.write(
      Keys.session(session.sessionID),
      Record.SessionDirectory.parse({
        ...session,
        executionGrantIDs: [...session.executionGrantIDs, grant.grantID],
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
    await Storage.write(
      Keys.executionGrant(grant.grantID),
      Execution.Grant.parse({ ...grant, state: "closed", closedAt: Date.now() }),
    )
    await Storage.write(
      Keys.session(session.sessionID),
      Record.SessionDirectory.parse({
        ...session,
        executionGrantIDs: session.executionGrantIDs.filter((id) => id !== grant.grantID),
        rowRevision: session.rowRevision + 1,
      }),
    )
  }
}

type ReceiptProof = Execution.BindingProof | Execution.DescriptionProof

export function createExecutionGrants(options: { connections: RuntimeConnections; admissions: CommandAdmissions }) {
  function window(proof: ReceiptProof) {
    if (proof.issuedAt > Date.now() || proof.expiresAt <= Date.now())
      fail("PERMISSION_DENIED", "Execution binding proof is outside its validity window")
  }
  async function machine(proof: ReceiptProof) {
    const runtime = await Record.read(Record.RuntimeRegistration, Keys.runtime(proof.runtimeID))
    if (
      !runtime ||
      runtime.runtimeID !== proof.runtimeID ||
      runtime.orgID !== proof.orgID ||
      runtime.deploymentIncarnation !== proof.deploymentIncarnation ||
      runtime.state !== "active" ||
      runtime.connectionEpoch !== proof.connectionEpoch
    )
      fail("PERMISSION_DENIED", "Execution binding Runtime is not authorized")
    const account = await Record.read(Record.Account, Keys.account(runtime.accountID))
    if (
      !account ||
      account.accountID !== runtime.accountID ||
      account.orgID !== runtime.orgID ||
      account.state !== "active"
    )
      fail("PERMISSION_DENIED", "Execution binding Runtime account is not active")
    return { runtime, account }
  }
  function capture(proof: ReceiptProof, accountID: string) {
    const connection = options.connections.capture(proof.runtimeID)
    if (
      connection.handshake.orgID !== proof.orgID ||
      connection.handshake.deploymentIncarnation !== proof.deploymentIncarnation ||
      connection.handshake.connectionEpoch !== proof.connectionEpoch ||
      connection.handshake.runtimeKind !== "member" ||
      connection.handshake.accountID !== accountID
    )
      fail("STALE_CONNECTION", "Execution binding connection changed")
    return connection
  }
  async function resolve(proof: ReceiptProof, publicKey: string) {
    const { runtime, account } = await machine(proof)
    if (runtime.publicKey !== publicKey) fail("PERMISSION_DENIED", "Execution binding identity changed")
    const accepted = proof.receipt.accepted!
    const permit = accepted.permit
    const session = await Record.read(Record.SessionDirectory, Keys.session(permit.sessionID))
    if (
      !session ||
      session.sessionID !== permit.sessionID ||
      session.orgID !== proof.orgID ||
      session.projectID !== permit.projectID ||
      session.driverRuntimeID !== runtime.runtimeID ||
      session.bindingEpoch !== permit.bindingEpoch
    )
      fail("STALE_BINDING", "Execution grant Session binding changed")
    if (session.handoffID) fail("HANDOFF_BLOCKED", "Session handoff blocks execution binding")
    const [project, membership] = await Promise.all([
      Record.read(Record.Project, Keys.project(session.projectID)),
      Record.read(Record.ProjectMember, Keys.projectMember(session.projectID, account.accountID)),
    ])
    if (!project) fail("NOT_FOUND", "Project not found")
    const view = projectView(account, project, membership, "project.read")
    if (!projectExecutionRole(view.role)) fail("PERMISSION_DENIED", "Runtime account cannot execute project work")
    const grant = await Record.read(Record.ExecutionGrant, Keys.executionGrant(permit.provisionalGrantID!))
    if (
      !grant ||
      grant.grantID !== permit.provisionalGrantID ||
      grant.orgID !== permit.orgID ||
      grant.deploymentIncarnation !== permit.deploymentIncarnation ||
      grant.sessionID !== permit.sessionID ||
      grant.projectID !== permit.projectID ||
      grant.runtimeID !== permit.runtimeID ||
      grant.bindingEpoch !== permit.bindingEpoch ||
      grant.attemptID !== permit.attemptID ||
      grant.admissionID !== permit.admissionID ||
      JSON.stringify(grant.actor) !== JSON.stringify(permit.actor) ||
      !session.executionGrantIDs.includes(grant.grantID)
    )
      fail("PERMISSION_DENIED", "Execution grant does not match the accepted admission")
    if (grant.state === "closed") fail("PERMISSION_DENIED", "Execution grant is closed")
    const contract = await Resources.read(session)
    if (
      !contract ||
      contract.revision !== grant.selectionRevision ||
      JSON.stringify(contract.selection) !== JSON.stringify(grant.selection)
    )
      fail("REVISION_CONFLICT", "Session resource selection changed")
    const resources = await Resources.enabled(session, grant.selection)
    return { session, grant, resources }
  }
  return {
    async describe(value: Execution.DescriptionRequest): Promise<Execution.Description> {
      if (Storage.inTransaction()) fail("INVALID_REQUEST", "Resource description must own its reconciliation boundary")
      const { proof, signature } = Execution.DescriptionRequest.parse(value)
      window(proof)
      const registered = await Storage.snapshot(() => machine(proof))
      if (!(await Execution.verifyDescription(proof, signature, registered.runtime.publicKey)))
        fail("PERMISSION_DENIED", "Execution resource proof signature is invalid")
      const connection = capture(proof, registered.account.accountID)
      await options.admissions.observe(connection, proof.receipt)
      return Storage.snapshot(async () => {
        const { grant, resources } = await resolve(proof, registered.runtime.publicKey)
        window(proof)
        connection.assertCurrent()
        return Execution.Description.parse({
          grant,
          resources: resources.map((resource) => {
            const { endpoint: _, ...definition } = resource.configuration
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
      const connection = capture(proof, registered.account.accountID)
      await options.admissions.observe(connection, proof.receipt)
      return Storage.transaction(
        async () => {
          window(proof)
          connection.assertCurrent()
          const { session, grant } = await resolve(proof, registered.runtime.publicKey)
          const key = Keys.rootGrant(session.sessionID, session.bindingEpoch, proof.rootID)
          const previous = await Record.read(Record.RootGrant, key)
          if (previous && previous.grantID !== grant.grantID)
            fail("REVISION_CONFLICT", "Root already has a different execution grant")
          if (grant.state === "bound") {
            if (grant.rootID !== proof.rootID || !previous)
              fail("PROTOCOL_MISMATCH", "Execution root binding is inconsistent")
            return grant
          }
          const bound = Execution.BoundGrant.parse({
            ...grant,
            state: "bound",
            rootID: proof.rootID,
            boundAt: Date.now(),
          })
          await Storage.write(Keys.executionGrant(grant.grantID), bound)
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
  }
}
export type ExecutionGrants = ReturnType<typeof createExecutionGrants>
