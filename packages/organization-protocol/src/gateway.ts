import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"
import { OrganizationProtocol as Protocol } from "./core.js"
import { OrganizationExecutionProtocol as Execution } from "./execution.js"
import { SigningSignature, signedProtocol } from "./signature.js"

export namespace OrganizationGatewayProtocol {
  export const Target = z.strictObject({
    orgID: Identity.ID,
    deploymentIncarnation: Identity.ID,
    runtimeID: Identity.ID,
    connectionEpoch: Protocol.Epoch,
    grantID: Identity.ID,
    sessionID: Identity.ID,
    rootID: Identity.ID,
    bindingEpoch: Protocol.Epoch,
    resourceID: Identity.ID,
    callID: Identity.ID,
  })
  export type Target = z.infer<typeof Target>
  const Window = { issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative() }
  function finite(value: { issuedAt: number; expiresAt: number }) {
    return value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= 60_000
  }
  export const Proof = Target.extend({ schemaVersion: z.literal(1), purpose: z.literal("gateway-call"), ...Window })
    .refine(finite, "Gateway authority requires a window of at most one minute")
    .meta({ ref: "OrgGatewayProof" })
  export type Proof = z.infer<typeof Proof>
  export const Request = z
    .strictObject({ proof: Proof, signature: SigningSignature })
    .meta({ ref: "OrgGatewayRequest" })
  export type Request = z.infer<typeof Request>
  export const ModelProtocol = z.enum(["openai-compatible", "anthropic-compatible"])
  export type ModelProtocol = z.infer<typeof ModelProtocol>
  export const Permit = Target.extend({
    schemaVersion: z.literal(1),
    purpose: z.literal("gateway-invocation"),
    keyID: Identity.ID,
    resourceRevision: Identity.Revision,
    protocol: ModelProtocol,
    modelID: z.string().min(1).max(256),
    requestBytes: Execution.Limits.shape.requestBytes,
    responseBytes: Execution.Limits.shape.responseBytes,
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(15 * 60_000),
    ...Window,
  })
    .refine(finite, "Gateway capabilities require a window of at most one minute")
    .meta({ ref: "OrgGatewayPermit" })
  export type Permit = z.infer<typeof Permit>
  export const SignedPermit = z
    .strictObject({ permit: Permit, signature: SigningSignature })
    .meta({ ref: "OrgGatewaySignedPermit" })
  export type SignedPermit = z.infer<typeof SignedPermit>
  export const Receipt = Target.extend({
    state: z.enum(["reserved", "started", "response_complete", "unknown"]),
    createdAt: z.number().int().nonnegative(),
    startedAt: z.number().int().nonnegative().optional(),
    finishedAt: z.number().int().nonnegative().optional(),
    requestHash: Protocol.Digest.optional(),
    requestBytes: z.number().int().nonnegative().optional(),
    responseBytes: z.number().int().nonnegative().optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  })
    .refine((value) => {
      if (value.state === "reserved")
        return (
          value.startedAt === undefined &&
          value.finishedAt === undefined &&
          value.requestHash === undefined &&
          value.requestBytes === undefined &&
          value.responseBytes === undefined &&
          value.httpStatus === undefined
        )
      if (value.startedAt === undefined || value.requestHash === undefined || value.requestBytes === undefined)
        return false
      if (value.state === "started")
        return value.finishedAt === undefined && value.responseBytes === undefined && value.httpStatus === undefined
      return (
        value.finishedAt !== undefined &&
        value.responseBytes !== undefined &&
        (value.state !== "response_complete" || value.httpStatus !== undefined)
      )
    }, "Gateway receipt must retain the evidence for its state")
    .meta({ ref: "OrgGatewayReceipt" })
  export type Receipt = z.infer<typeof Receipt>
  const requestSignatures = signedProtocol(Proof, "synergy.organization.gateway.call-request.v1\n")
  const permitSignatures = signedProtocol(Permit, "synergy.organization.gateway.invocation.v1\n")
  export const signRequest = requestSignatures.sign
  export const verifyRequest = requestSignatures.verify
  export const signPermit = permitSignatures.sign
  export const verifyPermit = permitSignatures.verify
  export function encode(value: SignedPermit) {
    const bytes = new TextEncoder().encode(JSON.stringify(SignedPermit.parse(value)))
    return btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "")
  }
  export function decode(value: string): SignedPermit {
    if (!value || value.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error("Invalid gateway capability")
    const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0))
    return SignedPermit.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
  }
}
