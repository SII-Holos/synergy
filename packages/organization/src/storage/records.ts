import { z } from "zod"
import {
  OrganizationProtocol,
  OrganizationIdentity as Identity,
  OrganizationRuntimeProtocol as Runtime,
  OrganizationClientAuth as ClientAuth,
  OrganizationSessionProtocol as Session,
  OrganizationCommandProtocol as Command,
  OrganizationResourceProtocol as ResourceProtocol,
  OrganizationExecutionProtocol as Execution,
  OrganizationGatewayProtocol as Gateway,
  OrganizationSyncProtocol as Sync,
} from "@ericsanchezok/synergy-organization-protocol"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { upgradeAccessRecord } from "@ericsanchezok/synergy-harness/migration/import"

export namespace OrganizationRecord {
  export const ExecutionUsage = z.strictObject({
    schemaVersion: z.literal(1),
    grantID: Identity.ID,
    calls: z.number().int().nonnegative(),
  })
  export const GatewayCall = z
    .strictObject({
      schemaVersion: z.literal(2),
      retentionGeneration: z.number().int().positive().safe(),
      authorization: Gateway.SignedPermit,
      receipt: Gateway.Receipt,
    })
    .refine(
      (value) =>
        Object.keys(Gateway.Target.shape).every(
          (key) =>
            value.authorization.permit[key as keyof Gateway.Target] === value.receipt[key as keyof Gateway.Target],
        ),
      "Gateway receipt must match its issued authority",
    )
  export const SessionResources = Execution.Contract.extend({ schemaVersion: z.literal(1), orgID: Identity.ID }).refine(
    (value) => value.selection !== null && value.revision > 0,
    "Stored resource contracts require a selection",
  )
  export type SessionResources = z.infer<typeof SessionResources>
  export const ExecutionGrant = Execution.Grant
  export const ExecutionRelease = Execution.ReleaseReceipt
  export const RootGrant = z.strictObject({ grantID: Identity.ID })
  export const Resource = ResourceProtocol.AdminView.safeExtend({
    schemaVersion: z.literal(1),
    secretID: Identity.ID.optional(),
  }).refine(
    (value) => (value.credential.kind === "none") === (value.secretID === undefined),
    "Configured credentials require a private secret reference",
  )
  export type Resource = z.infer<typeof Resource>
  export const ResourceSecret = z.strictObject({
    schemaVersion: z.literal(1),
    orgID: Identity.ID,
    resourceID: Identity.ID,
    credential: ResourceProtocol.Credential.refine((value) => value.kind !== "none"),
  })
  export const ResourceGrant = ResourceProtocol.Grant.extend({ schemaVersion: z.literal(1) })
  export type ResourceGrant = z.infer<typeof ResourceGrant>
  export const ResourceAccess = z.strictObject({ resourceID: Identity.ID, subject: ResourceProtocol.Subject })
  export const SigningIdentity = Command.SigningIdentity.extend({
    pkcs8: z.string().regex(/^(?:[a-f0-9]{2}){1,1024}$/),
  })
  export const CommandRequest = z
    .strictObject({
      schemaVersion: z.literal(1),
      first: Command.Permit,
      lastAttemptID: Identity.ID,
      accepted: Command.Accepted.optional(),
    })
    .refine(
      (value) =>
        !value.accepted ||
        (value.first.actor.subjectID === value.accepted.permit.actor.subjectID &&
          (["orgID", "requestID", "sessionID", "projectID", "runtimeID", "operation", "payloadHash"] as const).every(
            (key) => value.first[key] === value.accepted!.permit[key],
          )),
      "Accepted command must belong to the retained logical request",
    )
  export const CommandAttempt = z
    .strictObject({
      schemaVersion: z.literal(1),
      authorization: Command.SignedPermit,
      state: Command.AttemptState,
      updatedAt: z.number().int().nonnegative(),
      result: Command.Result.optional(),
      skip: Command.SignedSkip.optional(),
    })
    .refine(
      (value) =>
        !value.result || JSON.stringify(value.result.attempt.permit) === JSON.stringify(value.authorization.permit),
      "Runtime result must belong to the retained admission",
    )
  export type CommandAttempt = z.infer<typeof CommandAttempt>
  export const CommandAttemptIndex = z.strictObject({ attemptID: Identity.ID })
  export const CommandState = z.strictObject({
    schemaVersion: z.literal(1),
    commandSeq: Identity.Revision,
    pendingAttemptID: Identity.ID.optional(),
  })
  export const Info = Identity.Organization.extend({ schemaVersion: z.literal(1), owners: z.array(Identity.ID).min(1) })
  export const Account = Identity.Account.extend({ schemaVersion: z.literal(1), passwordHash: z.string().min(1) })
  export type Account = z.infer<typeof Account>
  export const LoginIndex = z.strictObject({ accountID: Identity.ID })
  const consumed = z.strictObject({ requestID: Identity.ID, fingerprint: Identity.Token, accountID: Identity.ID })
  const tokenState = z.strictObject({
    schemaVersion: z.literal(1),
    tokenHash: Identity.Token,
    expiresAt: z.number().int(),
  })
  export const Bootstrap = tokenState.extend({ consumed: consumed.extend({ result: Identity.Account }).optional() })
  export const Invite = Bootstrap.extend({
    createdBy: Identity.ID,
    issuerAuthRevision: Identity.Revision,
    role: z.enum(["admin", "member"]),
    revokedAt: z.number().int().optional(),
  })
  export const Reset = tokenState.extend({
    consumed: consumed.optional(),
    createdBy: Identity.ID,
    issuerAuthRevision: Identity.Revision,
    accountID: Identity.ID,
    authRevision: Identity.Revision,
  })
  export const Login = z.strictObject({
    schemaVersion: z.literal(1),
    tokenHash: Identity.Token,
    accountID: Identity.ID,
    authRevision: Identity.Revision,
    csrfHash: Identity.Token,
    expiresAt: z.number().int(),
    revokedAt: z.number().int().optional(),
  })
  export const ClientGrant = ClientAuth.Authority.extend({
    schemaVersion: z.literal(1),
    grantID: Identity.ID,
    clientID: Identity.ID,
    clientHash: Identity.Token,
    loginHash: Identity.Token,
    expiresAt: z.number().int(),
    revokedAt: z.number().int().optional(),
  })
  export type ClientGrant = z.infer<typeof ClientGrant>
  export const AuthorizationCode = ClientAuth.Authorize.extend({
    schemaVersion: z.literal(1),
    tokenHash: Identity.Token,
    clientHash: Identity.Token,
    loginHash: Identity.Token,
    expiresAt: z.number().int(),
    consumedAt: z.number().int().optional(),
  })
  export const ClientAccess = tokenState.extend({ grantID: Identity.ID })
  export const ClientRefresh = tokenState.extend({ grantID: Identity.ID, consumedAt: z.number().int().optional() })
  export const Project = Identity.Project.extend({ schemaVersion: z.literal(1) })
  export const RuntimeRegistration = Runtime.StoredRegistration
  export type RuntimeRegistration = z.infer<typeof RuntimeRegistration>
  export const RuntimeConnection = z.strictObject({
    schemaVersion: z.literal(1),
    handshake: Runtime.ConnectionProof.shape.handshake,
    connectedAt: z.number().int().nonnegative(),
    lastSeen: z.number().int().nonnegative(),
  })
  export const RuntimeIndex = z.strictObject({ runtimeID: Identity.ID })
  export const RuntimeTicket = tokenState.extend({
    runtimeID: Identity.ID,
    accountID: Identity.ID,
    authRevision: Identity.Revision,
    registrationRevision: Identity.Revision,
    consumed: Runtime.Registration.optional(),
  })
  export const ProjectMember = z.strictObject({
    schemaVersion: z.literal(1),
    projectID: Identity.ID,
    accountID: Identity.ID,
    role: Identity.ProjectRole,
    revision: Identity.Revision,
  })
  export const SessionDirectory = Session.Metadata.extend({
    schemaVersion: z.literal(2),
    orgID: Identity.ID,
    nextBindingEpoch: z.number().int().positive(),
    shareGeneration: Identity.Revision,
    controlRevision: Identity.Revision,
    handoffID: Identity.ID.optional(),
    rowRevision: Identity.Revision,
    retainedExecutionGrants: z.number().int().nonnegative(),
  }).refine((value) => value.nextBindingEpoch > value.bindingEpoch, "Next binding epoch must advance")
  export type SessionDirectory = z.infer<typeof SessionDirectory>
  export const SessionIndex = z.strictObject({ sessionID: Identity.ID })
  export const SharedState = z.strictObject({
    schemaVersion: z.literal(1),
    sessionID: Identity.ID,
    shareGeneration: Identity.Revision,
    bindingEpoch: OrganizationProtocol.Epoch,
    nextSeq: Identity.Revision,
    syncState: Sync.SyncState,
    updatedAt: z.number().int().nonnegative(),
  })
  export type SharedState = z.infer<typeof SharedState>
  export const SharedBatch = z.strictObject({
    schemaVersion: z.literal(1),
    sessionID: Identity.ID,
    projectID: Identity.ID,
    bindingEpoch: OrganizationProtocol.Epoch,
    shareGeneration: Identity.Revision,
    firstSeq: Identity.Revision,
    lastSeq: Identity.Revision,
    payloadHash: OrganizationProtocol.Digest,
    committedAt: z.number().int().nonnegative(),
  })
  export type SharedBatch = z.infer<typeof SharedBatch>
  export const SharedEvent = z.strictObject({
    schemaVersion: z.literal(1),
    event: Sync.Event,
  })
  export type SharedEvent = z.infer<typeof SharedEvent>
  export const SharedSession = z.strictObject({
    schemaVersion: z.literal(1),
    rootSessionID: Identity.ID,
    projection: Sync.SessionProjection,
  })
  export type SharedSession = z.infer<typeof SharedSession>
  export const SharedBlob = z.strictObject({
    schemaVersion: z.literal(1),
    sessionID: Identity.ID,
    shareGeneration: Identity.Revision,
    hash: OrganizationProtocol.Digest,
    bytes: z.number().int().nonnegative(),
    chunkBytes: z.literal(4 * 1024 * 1024),
    chunks: z
      .array(z.strictObject({ offset: z.number().int().nonnegative(), bytes: z.number().int().positive() }))
      .max(16_384),
    receivedBytes: z.number().int().nonnegative(),
    complete: z.boolean(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  export type SharedBlob = z.infer<typeof SharedBlob>

  export async function read<T>(schema: z.ZodType<T>, key: string[]): Promise<T | undefined> {
    const [value] = await Storage.readMany<unknown>([key])
    return value === undefined ? undefined : parse(schema, key, value)
  }

  export function parse<T>(schema: z.ZodType<T>, key: string[], value: unknown): T {
    return schema.parse(upgradeAccessRecord(key, value))
  }

  export function publicAccount(account: Account): Identity.Account {
    const { schemaVersion: _, passwordHash: __, ...result } = account
    return Identity.Account.parse(result)
  }
}
