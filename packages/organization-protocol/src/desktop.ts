import { z } from "zod"
import { OrganizationClientAuth as Auth } from "./client-auth.js"
import { OrganizationIdentity as Identity } from "./identity.js"

export namespace OrganizationDesktop {
  export const Connect = z.strictObject({
    issuer: Auth.Origin,
    clientID: Identity.ID,
    expected: z
      .strictObject({
        orgID: Identity.ID,
        deploymentIncarnation: Identity.ID,
        accountID: Identity.ID.optional(),
      })
      .optional(),
  })
  export type Connect = z.infer<typeof Connect>
  export const Connection = Auth.Authority.extend({
    id: Identity.Token,
    clientID: Identity.ID,
    account: Identity.Account,
    state: z.enum(["ready", "reauthorization_required", "sign_out_pending", "signed_out"]),
  })
  export type Connection = z.infer<typeof Connection>
  export const Request = z.strictObject({
    requestID: Identity.ID,
    connectionID: Identity.Token,
    method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
    path: z.string().min(1).max(8192),
    body: z.string().max(65_536).optional(),
  })
  export type Request = z.infer<typeof Request>
  export const Response = z.strictObject({
    status: z.number().int().min(200).max(599),
    body: z.string().max(2_097_152),
  })
  export type Response = z.infer<typeof Response>
  export const Start = z.strictObject({ requestID: Identity.ID, target: Connect })
  export type Start = z.infer<typeof Start>
  export const Cancel = z.strictObject({ requestID: Identity.ID })
  export const Account = z.strictObject({ connectionID: Identity.Token })
  export const ErrorCode = z.enum([
    "invalid_request",
    "invalid_response",
    "identity_changed",
    "cancelled",
    "expired",
    "reauthorization_required",
    "signed_out",
    "revocation_pending",
    "credentials_unavailable",
    "credentials_invalid",
    "storage_unavailable",
    "unavailable",
    "untrusted_sender",
    "request_in_progress",
  ])
  export type ErrorCode = z.infer<typeof ErrorCode>
  export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: ErrorCode } }
  export interface Bridge {
    list(): Promise<Result<Connection[]>>
    connect(input: Start): Promise<Result<Connection>>
    request(input: Request): Promise<Result<Response>>
    cancel(input: z.infer<typeof Cancel>): Promise<Result<void>>
    signOut(input: z.infer<typeof Account>): Promise<Result<Connection>>
  }
}
