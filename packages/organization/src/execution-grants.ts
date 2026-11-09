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
    await Resources.enabled(session, contract.selection)
    const grant = Execution.Grant.parse({
      schemaVersion: 3,
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
    await Storage.write(Keys.executionGrant(grant.grantID), grant)
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
    await Storage.write(
      Keys.executionGrant(grant.grantID),
      Execution.Grant.parse({ ...grant, state: "closed", closedAt: Date.now() }),
    )
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

type ReceiptProof = Execution.BindingProof | Execution.DescriptionProof | Execution.ReleaseProof

export function createExecutionGrants(options: {
  connections: RuntimeConnections
  admissions: CommandAdmissions
  assertResourcesDrained(grantID: string): void
}) {
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
      (grant.state === "bound" && grant.rootID !== accepted.effect.messageID) ||
      JSON.stringify(grant.actor) !== JSON.stringify(permit.actor)
    )
      fail("PERMISSION_DENIED", "Execution grant does not match the accepted admission")
    return { session, grant, account }
  }
  async function enabled(session: Record.SessionDirectory, grant: Execution.Grant, account: Record.Account) {
    if (session.handoffID) fail("HANDOFF_BLOCKED", "Session handoff blocks execution binding")
    if (grant.state === "closed") fail("PERMISSION_DENIED", "Execution grant is closed")
    if ((grant.state === "provisional" || grant.retention.state === "held") && session.retainedExecutionGrants === 0)
      fail("PROTOCOL_MISMATCH", "Retained execution grant count is inconsistent")
    const [project, membership] = await Promise.all([
      Record.read(Record.Project, Keys.project(session.projectID)),
      Record.read(Record.ProjectMember, Keys.projectMember(session.projectID, account.accountID)),
    ])
    if (!project) fail("NOT_FOUND", "Project not found")
    const view = projectView(account, project, membership, "project.read")
    if (!projectExecutionRole(view.role)) fail("PERMISSION_DENIED", "Runtime account cannot execute project work")
    const contract = await Resources.read(session)
    if (
      !contract ||
      contract.revision !== grant.selectionRevision ||
      JSON.stringify(contract.selection) !== JSON.stringify(grant.selection)
    )
      fail("REVISION_CONFLICT", "Session resource selection changed")
    return Resources.enabled(session, grant.selection)
  }
  return {
    async retention(value: Execution.DescriptionRequest): Promise<Execution.Grant> {
      if (Storage.inTransaction()) fail("INVALID_REQUEST", "Retention inspection must own its reconciliation boundary")
      const { proof, signature } = Execution.DescriptionRequest.parse(value)
      window(proof)
      const registered = await Storage.snapshot(() => machine(proof))
      if (!(await Execution.verifyDescription(proof, signature, registered.runtime.publicKey)))
        fail("PERMISSION_DENIED", "Execution retention proof signature is invalid")
      const connection = capture(proof, registered.account.accountID)
      await options.admissions.observe(connection, proof.receipt)
      return Storage.snapshot(async () => {
        const { grant } = await resolve(proof, registered.runtime.publicKey)
        window(proof)
        connection.assertCurrent()
        return grant
      })
    },
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
        const { session, grant, account } = await resolve(proof, registered.runtime.publicKey)
        const resources = await enabled(session, grant, account)
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
            await Storage.write(Keys.executionGrant(grant.grantID), retained)
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
    async release(value: Execution.ReleaseRequest): Promise<Execution.ReleaseReceipt> {
      if (Storage.inTransaction()) fail("INVALID_REQUEST", "Execution release must own its commit boundary")
      const { proof, signature } = Execution.ReleaseRequest.parse(value)
      window(proof)
      const registered = await Storage.snapshot(() => machine(proof))
      if (!(await Execution.verifyRelease(proof, signature, registered.runtime.publicKey)))
        fail("PERMISSION_DENIED", "Execution release signature is invalid")
      const connection = capture(proof, registered.account.accountID)
      await options.admissions.observe(connection, proof.receipt)
      let releasingGrantID: string | undefined
      return Storage.transaction(
        async () => {
          window(proof)
          connection.assertCurrent()
          const { session, grant } = await resolve(proof, registered.runtime.publicKey)
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
          await Storage.write(
            Keys.executionGrant(grant.grantID),
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
