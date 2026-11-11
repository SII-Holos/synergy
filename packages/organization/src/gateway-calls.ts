import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import {
  OrganizationGatewayProtocol as Gateway,
  OrganizationExecutionProtocol as Execution,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { OrganizationSessionResources } from "./session-resources"
import { projectView, projectExecutionRole } from "./authorization"
import { fail, OrganizationError } from "./error"
import type { RuntimeConnections } from "./runtime-connection"
import type { CommandSigningAuthority } from "./signing"
import { runtimeAuthority } from "./runtime-authority"

function sameCall(left: Gateway.Target, right: Gateway.Target) {
  return (Object.keys(Gateway.Target.shape) as (keyof Gateway.Target)[]).every(
    (key) => key === "connectionEpoch" || left[key] === right[key],
  )
}

export function createGatewayCalls(options: { connections: RuntimeConnections; signing: CommandSigningAuthority }) {
  function window(value: { issuedAt: number; expiresAt: number }) {
    if (value.issuedAt > Date.now() || value.expiresAt <= Date.now())
      fail("PERMISSION_DENIED", "Gateway authority expired")
  }
  function boundary() {
    if (Storage.inTransaction()) fail("INVALID_REQUEST", "Gateway calls must own their transaction boundary")
  }
  async function machine(target: Gateway.Target) {
    const identity = options.signing.identity
    if (target.orgID !== identity.orgID || target.deploymentIncarnation !== identity.deploymentIncarnation)
      fail("PERMISSION_DENIED", "Gateway authority belongs to another deployment")
    return runtimeAuthority(target)
  }
  function connection(target: Gateway.Target) {
    const lease = options.connections.capture(target.runtimeID)
    if (
      lease.handshake.orgID !== target.orgID ||
      lease.handshake.deploymentIncarnation !== target.deploymentIncarnation ||
      lease.handshake.connectionEpoch !== target.connectionEpoch
    )
      fail("STALE_CONNECTION", "Gateway Runtime connection changed")
    return lease
  }
  async function access(target: Gateway.Target, invoke: boolean) {
    const { runtime, account } = await machine(target)
    const [grant, session, root] = await Promise.all([
      Record.read(Record.ExecutionGrant, Keys.executionGrant(target.grantID)),
      Record.read(Record.SessionDirectory, Keys.session(target.sessionID)),
      Record.read(Record.RootGrant, Keys.rootGrant(target.sessionID, target.bindingEpoch, target.rootID)),
    ])
    if (
      !grant ||
      grant.state !== "bound" ||
      grant.grantID !== target.grantID ||
      grant.orgID !== target.orgID ||
      grant.deploymentIncarnation !== target.deploymentIncarnation ||
      grant.sessionID !== target.sessionID ||
      grant.rootID !== target.rootID ||
      grant.runtimeID !== target.runtimeID ||
      grant.bindingEpoch !== target.bindingEpoch ||
      root?.grantID !== grant.grantID
    )
      fail("PERMISSION_DENIED", "Gateway call requires the exact bound root grant")
    if (
      !session ||
      session.sessionID !== grant.sessionID ||
      session.orgID !== grant.orgID ||
      session.projectID !== grant.projectID ||
      session.driverRuntimeID !== runtime.runtimeID ||
      session.bindingEpoch !== grant.bindingEpoch
    )
      fail("STALE_BINDING", "Gateway Session ownership changed")
    if (invoke && (grant.retention.state !== "held" || session.retainedExecutionGrants === 0))
      fail("PERMISSION_DENIED", "Root resources have been released")
    if (invoke && session.handoffID) fail("HANDOFF_BLOCKED", "Session handoff blocks new resource calls")
    const [project, membership, contract] = await Promise.all([
      Record.read(Record.Project, Keys.project(grant.projectID)),
      account ? Record.read(Record.ProjectMember, Keys.projectMember(grant.projectID, account.accountID)) : undefined,
      OrganizationSessionResources.read(session),
    ])
    if (!project) fail("NOT_FOUND", "Project not found")
    if (account && !projectExecutionRole(projectView(account, project, membership, "project.read").role))
      fail("PERMISSION_DENIED", "Runtime account cannot execute project work")
    if (
      invoke &&
      (!contract ||
        contract.revision !== grant.selectionRevision ||
        JSON.stringify(contract.selection) !== JSON.stringify(grant.selection))
    )
      fail("REVISION_CONFLICT", "Gateway resource contract changed")
    if (!Execution.resourceIDs(grant.selection).includes(target.resourceID))
      fail("PERMISSION_DENIED", "Resource is outside the root grant")
    const resource = await Record.read(Record.Resource, Keys.resource(target.orgID, target.resourceID))
    if (
      !resource ||
      resource.orgID !== target.orgID ||
      resource.resourceID !== target.resourceID ||
      (resource.scope.kind === "project" && resource.scope.projectID !== grant.projectID)
    )
      fail("PERMISSION_DENIED", "Resource does not belong to this execution")
    if (invoke && resource.state !== "enabled") fail("RESOURCE_UNAVAILABLE", "Resource is disabled")
    return { grant, resource }
  }
  async function verify(value: Gateway.Request) {
    const request = Gateway.Request.parse(value)
    window(request.proof)
    const registered = await Storage.snapshot(() => machine(request.proof))
    if (!(await Gateway.verifyRequest(request.proof, request.signature, registered.runtime.publicKey)))
      fail("PERMISSION_DENIED", "Gateway request signature is invalid")
    const lease = connection(request.proof)
    return { ...request, lease, publicKey: registered.runtime.publicKey }
  }
  async function call(authorization: Gateway.SignedPermit, generation?: number) {
    const stored = await Record.read(
      Record.GatewayCall,
      Keys.gatewayCall(authorization.permit.grantID, authorization.permit.callID),
    )
    if (!stored || JSON.stringify(stored.authorization) !== JSON.stringify(authorization))
      fail("PERMISSION_DENIED", "Gateway capability was not issued for this call")
    if (generation !== undefined && stored.retentionGeneration !== generation)
      fail("PERMISSION_DENIED", "Gateway capability belongs to a released resource generation")
    return stored
  }
  return {
    async reserve(value: Gateway.Request): Promise<Gateway.SignedPermit> {
      boundary()
      const { proof, lease, publicKey } = await verify(value)
      return Storage.transaction(
        async () => {
          window(proof)
          lease.assertCurrent()
          if ((await machine(proof)).runtime.publicKey !== publicKey)
            fail("PERMISSION_DENIED", "Runtime identity changed")
          const { grant, resource } = await access(proof, true)
          const configuration = resource.configuration
          if (configuration.protocol === "workspace-storage" || configuration.protocol === "environment")
            fail("PROTOCOL_MISMATCH", "This resource requires the cloud owner protocol")
          const previous = await Record.read(Record.GatewayCall, Keys.gatewayCall(grant.grantID, proof.callID))
          if (previous) {
            if (!sameCall(previous.authorization.permit, proof))
              fail("REVISION_CONFLICT", "Call identity already belongs to another target")
            return previous.authorization
          }
          const usage = await Record.read(Record.ExecutionUsage, Keys.executionUsage(grant.grantID))
          if (usage && usage.grantID !== grant.grantID)
            fail("PROTOCOL_MISMATCH", "Execution usage identity is inconsistent")
          const common = {
            ...Gateway.Target.strip().parse(proof),
            schemaVersion: 1,
            purpose: "gateway-invocation",
            keyID: options.signing.identity.keyID,
            requestBytes: grant.limits.requestBytes,
            responseBytes: grant.limits.responseBytes,
            timeoutMs: 15 * 60_000,
            issuedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          } as const
          const authorization = await options.signing.signGateway(
            configuration.protocol === "openai-compatible" || configuration.protocol === "anthropic-compatible"
              ? {
                  ...common,
                  resourceRevision: resource.revision,
                  protocol: configuration.protocol,
                  modelID: configuration.model.id,
                }
              : { ...common, resourceRevision: resource.revision, protocol: configuration.protocol },
          )
          await Storage.write(
            Keys.executionUsage(grant.grantID),
            Record.ExecutionUsage.parse({ schemaVersion: 1, grantID: grant.grantID, calls: (usage?.calls ?? 0) + 1 }),
          )
          await Storage.write(
            Keys.gatewayCall(grant.grantID, proof.callID),
            Record.GatewayCall.parse({
              schemaVersion: 2,
              retentionGeneration: grant.retention.generation,
              authorization,
              receipt: {
                ...Gateway.Target.strip().parse(proof),
                state: "reserved",
                createdAt: authorization.permit.issuedAt,
              },
            }),
          )
          return authorization
        },
        {
          commitGuard() {
            window(proof)
            lease.assertCurrent()
          },
        },
      )
    },
    async inspect(value: Gateway.Request): Promise<Gateway.Receipt> {
      boundary()
      const { proof, lease, publicKey } = await verify(value)
      return Storage.snapshot(async () => {
        window(proof)
        lease.assertCurrent()
        if ((await machine(proof)).runtime.publicKey !== publicKey)
          fail("PERMISSION_DENIED", "Runtime identity changed")
        await access(proof, false)
        const stored = await Record.read(Record.GatewayCall, Keys.gatewayCall(proof.grantID, proof.callID))
        if (!stored || !sameCall(stored.receipt, proof)) fail("NOT_FOUND", "Gateway call not found")
        return stored.receipt
      })
    },
    async authorize(value: Gateway.SignedPermit) {
      boundary()
      const authorization = Gateway.SignedPermit.parse(value)
      const permit = authorization.permit
      window(permit)
      if (
        permit.keyID !== options.signing.identity.keyID ||
        !(await Gateway.verifyPermit(permit, authorization.signature, options.signing.identity.publicKey))
      )
        fail("PERMISSION_DENIED", "Gateway capability signature is invalid")
      connection(permit).assertCurrent()
      await Storage.snapshot(async () => {
        const { grant } = await access(permit, true)
        await call(authorization, grant.retention.generation)
      })
      return authorization
    },
    async start(authorization: Gateway.SignedPermit, input: { hash: string; bytes: number; signal: AbortSignal }) {
      boundary()
      const { permit } = authorization
      const lease = connection(permit)
      return Storage.transaction(
        async () => {
          window(permit)
          lease.assertCurrent()
          input.signal.throwIfAborted()
          const { resource, grant } = await access(permit, true)
          if (resource.revision !== permit.resourceRevision || resource.configuration.protocol !== permit.protocol)
            fail("REVISION_CONFLICT", "Resource configuration changed before dispatch")
          const stored = await call(authorization, grant.retention.generation)
          if (stored.receipt.state !== "reserved")
            throw new OrganizationError({
              code: "REVISION_CONFLICT",
              message: "This call already started; inspect its receipt before creating another call",
              outcome: "unknown",
              retryable: false,
            })
          if (input.bytes > permit.requestBytes)
            fail("RESOURCE_UNAVAILABLE", "Gateway request exceeds its byte allowance")
          const secret = resource.secretID
            ? await Record.read(Record.ResourceSecret, Keys.resourceSecret(resource.secretID))
            : undefined
          if (
            resource.secretID &&
            (!secret ||
              secret.orgID !== resource.orgID ||
              secret.resourceID !== resource.resourceID ||
              secret.credential.kind !== resource.credential.kind ||
              (secret.credential.kind === "header" &&
                resource.credential.kind === "header" &&
                secret.credential.name !== resource.credential.name))
          )
            fail("RESOURCE_UNAVAILABLE", "Resource credentials are unavailable")
          await Storage.write(
            Keys.gatewayCall(permit.grantID, permit.callID),
            Record.GatewayCall.parse({
              ...stored,
              receipt: {
                ...stored.receipt,
                state: "started",
                startedAt: Date.now(),
                requestHash: input.hash,
                requestBytes: input.bytes,
              },
            }),
          )
          return { configuration: resource.configuration, credential: secret?.credential ?? { kind: "none" as const } }
        },
        {
          commitGuard() {
            window(permit)
            lease.assertCurrent()
            input.signal.throwIfAborted()
          },
        },
      )
    },
    async finish(
      authorization: Gateway.SignedPermit,
      input: { state: "response_complete" | "unknown"; responseBytes: number; httpStatus?: number },
    ) {
      boundary()
      const { permit } = authorization
      return Storage.transaction(async () => {
        const stored = await call(authorization)
        if (stored.receipt.state !== "started") return
        await Storage.write(
          Keys.gatewayCall(permit.grantID, permit.callID),
          Record.GatewayCall.parse({ ...stored, receipt: { ...stored.receipt, ...input, finishedAt: Date.now() } }),
        )
      })
    },
  }
}
export type GatewayCalls = ReturnType<typeof createGatewayCalls>
