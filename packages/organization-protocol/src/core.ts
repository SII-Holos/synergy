import { z } from "zod"
import { OrganizationIdentity } from "./identity.js"

export namespace OrganizationProtocol {
  export const version = 1
  export const Identity = z.string().min(1)
  export const Epoch = z.number().int().positive()
  export const Revision = z.number().int().nonnegative()
  export const Digest = z.string().regex(/^[a-f0-9]{64}$/)
  export const SessionBinding = z
    .strictObject({
      schemaVersion: z.literal(1),
      orgID: OrganizationIdentity.ID,
      projectID: OrganizationIdentity.ID,
      creatorID: OrganizationIdentity.ID,
      driverRuntimeID: OrganizationIdentity.ID,
      bindingEpoch: Epoch,
    })
    .meta({ ref: "OrgSessionBinding" })
  export type SessionBinding = z.infer<typeof SessionBinding>

  const handshake = {
    type: z.literal("handshake"),
    protocolVersion: z.literal(version),
    orgID: Identity,
    deploymentIncarnation: Identity,
    runtimeID: Identity,
    buildVersion: z.string().min(1),
    connectionEpoch: Epoch,
    capabilities: z.array(z.string().min(1)),
    schemas: z.record(z.string().min(1), z.number().int().positive()),
  }
  export const Handshake = z
    .discriminatedUnion("runtimeKind", [
      z.strictObject({ ...handshake, runtimeKind: z.literal("member"), accountID: Identity, deviceID: Identity }),
      z.strictObject({ ...handshake, runtimeKind: z.literal("hosted") }),
    ])
    .meta({ ref: "OrgRuntimeHandshake" })
  export type Handshake = z.infer<typeof Handshake>

  export const PrivateSessionRegistration = z
    .strictObject({
      sessionID: OrganizationIdentity.ID,
      projectID: OrganizationIdentity.ID,
      creatorID: OrganizationIdentity.ID,
      driverRuntimeID: OrganizationIdentity.ID,
      bindingEpoch: Epoch,
      createdAt: z.number().int().nonnegative(),
      shareState: z.literal("private"),
      resourceIDs: z.array(OrganizationIdentity.ID),
    })
    .meta({ ref: "OrgPrivateSessionRegistration" })
  export type PrivateSessionRegistration = z.infer<typeof PrivateSessionRegistration>

  export const Deployment = z
    .strictObject({
      schemaVersion: z.literal(1),
      orgID: Identity,
      deploymentIncarnation: Identity,
      createdAt: z.number().int().nonnegative(),
    })
    .meta({ ref: "OrgDeployment" })
  export type Deployment = z.infer<typeof Deployment>

  export const ErrorCode = z.enum([
    "INVALID_REQUEST",
    "AUTHENTICATION_REQUIRED",
    "PERMISSION_DENIED",
    "NOT_FOUND",
    "RUNTIME_OFFLINE",
    "COMMAND_OUTCOME_UNKNOWN",
    "REVISION_CONFLICT",
    "STALE_BINDING",
    "STALE_CONNECTION",
    "SHARE_REVOKED",
    "HANDOFF_BLOCKED",
    "RESOURCE_UNAVAILABLE",
    "BLOB_INCOMPLETE",
    "PROTOCOL_MISMATCH",
    "SERVICE_UNAVAILABLE",
    "ALREADY_INITIALIZED",
    "LAST_OWNER",
    "TOKEN_CONSUMED",
    "LOGIN_NAME_TAKEN",
  ])
  export const Error = z
    .strictObject({
      code: ErrorCode,
      message: z.string(),
      requestID: Identity.optional(),
      retryable: z.boolean(),
      outcome: z.enum(["not_dispatched", "rejected", "unknown"]),
      currentRevision: Revision.optional(),
      currentConnectionEpoch: Revision.optional(),
      missingRequirements: z.array(z.string()).optional(),
      retryAfter: z.number().nonnegative().optional(),
    })
    .meta({ ref: "OrgError" })
  export type Error = z.infer<typeof Error>

  export const Health = z
    .strictObject({
      ready: z.boolean(),
      protocolVersion: z.literal(version),
    })
    .meta({ ref: "OrgHealth" })
  export const Liveness = z
    .strictObject({ alive: z.boolean(), protocolVersion: z.literal(version) })
    .meta({ ref: "OrgLiveness" })
}
