import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Protocol } from "./core.js"

export namespace OrganizationRuntimeProtocol {
  export const PublicKey = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .meta({ ref: "OrgRuntimePublicKey" })
  export const Signature = z.string().regex(/^[a-f0-9]{128}$/)
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
  export const ClientFrame = z.discriminatedUnion("type", [Connect.extend({ type: z.literal("handshake") }), Heartbeat])
  export type ClientFrame = z.infer<typeof ClientFrame>
  export const Connected = z.strictObject({
    type: z.literal("handshake"),
    protocolVersion: z.literal(Protocol.version),
    orgID: Identity.ID,
    deploymentIncarnation: Identity.ID,
    runtimeID: Identity.ID,
    connectionEpoch: Protocol.Epoch,
    heartbeatMs: z.number().int().positive(),
    offlineMs: z.number().int().positive(),
  })
  export const ServerFrame = z.discriminatedUnion("type", [
    Connected,
    Heartbeat,
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

  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)]),
      )
    return value
  }
  function bytes(value: Proof) {
    return new TextEncoder().encode(
      "synergy.organization.runtime.proof.v1\n" + JSON.stringify(canonical(Proof.parse(value))),
    )
  }
  function hex(value: ArrayBuffer) {
    return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("")
  }
  function decode(value: string) {
    return Uint8Array.from(value.match(/../g)!, (byte) => Number.parseInt(byte, 16))
  }

  // Provenance: https://www.rfc-editor.org/rfc/rfc8032 and https://nodejs.org/api/webcrypto.html
  // Local adaptation: Web Crypto Ed25519 over a versioned purpose prefix and sorted, strictly validated protocol objects.
  export async function publicKey(key: CryptoKey) {
    return PublicKey.parse(hex(await crypto.subtle.exportKey("raw", key)))
  }
  export async function sign(value: Proof, key: CryptoKey) {
    return Signature.parse(hex(await crypto.subtle.sign("Ed25519", key, bytes(value))))
  }
  export async function verify(value: unknown, signature: unknown, publicKey: unknown) {
    const proof = Proof.safeParse(value)
    const signed = Signature.safeParse(signature)
    const raw = PublicKey.safeParse(publicKey)
    if (!proof.success || !signed.success || !raw.success) return false
    try {
      const key = await crypto.subtle.importKey("raw", decode(raw.data), "Ed25519", false, ["verify"])
      return await crypto.subtle.verify("Ed25519", key, decode(signed.data), bytes(proof.data))
    } catch {
      return false
    }
  }
}
