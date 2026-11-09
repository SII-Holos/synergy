import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Protocol } from "./core.js"
import { OrganizationCommandProtocol as Command } from "./command.js"
import { OrganizationSyncProtocol as Sync } from "./sync.js"
import { SigningPublicKey, SigningSignature, signedProtocol } from "./signature.js"

export namespace OrganizationRuntimeProtocol {
  export const PublicKey = SigningPublicKey.meta({ ref: "OrgRuntimePublicKey" })
  export const Signature = SigningSignature
  export const MemberRegistration = z
    .strictObject({ deviceID: Identity.ID, publicKey: PublicKey })
    .meta({ ref: "OrgMemberRuntimeRegistration" })
  export type MemberRegistration = z.infer<typeof MemberRegistration>
  export const Registration = z
    .strictObject({
      runtimeID: Identity.ID,
      orgID: Identity.ID,
      deploymentIncarnation: Identity.ID,
      runtimeKind: z.literal("member"),
      accountID: Identity.ID,
      deviceID: Identity.ID,
      publicKey: PublicKey,
      state: z.enum(["pending", "active", "revoked"]),
      revision: Identity.Revision,
      connectionEpoch: Protocol.Revision,
      createdAt: z.number().int().nonnegative(),
      lastSeen: z.number().int().nonnegative().optional(),
    })
    .meta({ ref: "OrgRuntimeRegistration" })
  export type Registration = z.infer<typeof Registration>
  export const RegistrationPage = z
    .strictObject({ items: z.array(Registration), cursor: Identity.ID.optional() })
    .meta({ ref: "OrgRuntimeRegistrationPage" })
  export const Ticket = z
    .strictObject({ token: Identity.Token, expiresAt: z.number().int(), runtime: Registration })
    .meta({ ref: "OrgRuntimeRegistrationTicket" })
  export const RegistrationProof = z
    .strictObject({
      purpose: z.literal("runtime-register"),
      protocolVersion: z.literal(Protocol.version),
      orgID: Identity.ID,
      deploymentIncarnation: Identity.ID,
      runtimeID: Identity.ID,
      ticketHash: Protocol.Digest,
    })
    .meta({ ref: "OrgRuntimeRegistrationProof" })
  export type RegistrationProof = z.infer<typeof RegistrationProof>
  export const ConnectionProof = z
    .strictObject({
      purpose: z.literal("runtime-connect"),
      handshake: Protocol.Handshake,
      nonce: Protocol.Digest,
      issuedAt: z.number().int().nonnegative(),
    })
    .meta({ ref: "OrgRuntimeConnectionProof" })
  export type ConnectionProof = z.infer<typeof ConnectionProof>
  export const Proof = z.discriminatedUnion("purpose", [RegistrationProof, ConnectionProof])
  export type Proof = z.infer<typeof Proof>
  export const ConsumeTicket = z
    .strictObject({ token: Identity.Token, proof: RegistrationProof, signature: Signature })
    .meta({ ref: "OrgRuntimeConsumeTicket" })
  export type ConsumeTicket = z.infer<typeof ConsumeTicket>
  export const Connect = z
    .strictObject({ proof: ConnectionProof, signature: Signature })
    .meta({ ref: "OrgRuntimeConnect" })
  export type Connect = z.infer<typeof Connect>
  export const Revoke = z.strictObject({ expectedRevision: Identity.Revision }).meta({ ref: "OrgRuntimeRevoke" })
  export const Heartbeat = z.strictObject({
    type: z.literal("heartbeat"),
    connectionEpoch: Protocol.Epoch,
    sequence: Protocol.Revision,
  })
  export const Receipt = z.strictObject({
    type: z.literal("receipt"),
    connectionEpoch: Protocol.Epoch,
    exchangeID: Identity.ID,
    reply: Command.Reply,
  })
  export const SyncStateRequest = z.strictObject({
    type: z.literal("sync-state"),
    connectionEpoch: Protocol.Epoch,
    exchangeID: Identity.ID,
    sessionID: Identity.ID,
  })
  export type SyncStateRequest = z.infer<typeof SyncStateRequest>
  export const SyncBatch = z.strictObject({
    type: z.literal("sync-batch"),
    connectionEpoch: Protocol.Epoch,
    exchangeID: Identity.ID,
    batch: Sync.Batch,
  })
  export type SyncBatch = z.infer<typeof SyncBatch>
  export const BlobChunk = z.strictObject({
    type: z.literal("blob-chunk"),
    connectionEpoch: Protocol.Epoch,
    exchangeID: Identity.ID,
    sessionID: Identity.ID,
    shareGeneration: Identity.Revision,
    hash: Protocol.Digest,
    offset: z.number().int().nonnegative(),
    totalBytes: z.number().int().positive().safe(),
    index: z.number().int().nonnegative(),
    total: z.number().int().positive().max(128),
    data: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(60_000),
  })
  export type BlobChunk = z.infer<typeof BlobChunk>
  export const CommandChunk = z.strictObject({
    type: z.literal("command-chunk"),
    connectionEpoch: Protocol.Epoch,
    exchangeID: Identity.ID,
    index: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    data: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(60_000),
  })
  export type CommandChunk = z.infer<typeof CommandChunk>
  export const ClientFrame = z.discriminatedUnion("type", [
    Connect.extend({ type: z.literal("handshake") }),
    Heartbeat,
    Receipt,
    SyncStateRequest,
    SyncBatch,
    BlobChunk,
  ])
  export type ClientFrame = z.infer<typeof ClientFrame>
  export const Connected = z.strictObject({
    type: z.literal("handshake"),
    protocolVersion: z.literal(Protocol.version),
    orgID: Identity.ID,
    deploymentIncarnation: Identity.ID,
    runtimeID: Identity.ID,
    connectionEpoch: Protocol.Epoch,
    signingIdentity: Command.SigningIdentity,
    heartbeatMs: z.number().int().positive(),
    offlineMs: z.number().int().positive(),
  })
  export const ServerFrame = z.discriminatedUnion("type", [
    Connected,
    Heartbeat,
    z.strictObject({
      type: z.literal("command"),
      connectionEpoch: Protocol.Epoch,
      exchangeID: Identity.ID,
      command: Command.Delivery,
    }),
    CommandChunk,
    z.strictObject({
      type: z.literal("sync-state"),
      connectionEpoch: Protocol.Epoch,
      exchangeID: Identity.ID,
      share: Sync.Share,
    }),
    z.strictObject({
      type: z.literal("sync-ack"),
      connectionEpoch: Protocol.Epoch,
      exchangeID: Identity.ID,
      ack: Sync.Ack,
    }),
    z.strictObject({
      type: z.literal("blob-ack"),
      connectionEpoch: Protocol.Epoch,
      exchangeID: Identity.ID,
      status: Sync.BlobStatus,
    }),
    z.strictObject({ type: z.literal("error"), error: Protocol.Error }),
  ])
  export type ServerFrame = z.infer<typeof ServerFrame>
  export const ConnectionStatus = z
    .strictObject({
      runtimeID: Identity.ID,
      state: z.enum(["online", "offline"]),
      connectionEpoch: Protocol.Revision,
      lastSeen: z.number().int().nonnegative().optional(),
    })
    .meta({ ref: "OrgRuntimeConnectionStatus" })

  const signatures = signedProtocol(Proof, "synergy.organization.runtime.proof.v1\n")
  export const publicKey = signatures.publicKey
  export const sign = signatures.sign
  export const verify = signatures.verify
}
