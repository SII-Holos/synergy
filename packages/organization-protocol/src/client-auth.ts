import { z } from "zod"
import { OrganizationIdentity as Identity } from "./identity.js"

export namespace OrganizationClientAuth {
  export const Origin = z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value)
        return url.protocol === "https:" && url.origin === value
      } catch {
        return false
      }
    }, "An exact HTTPS origin is required")
  const webCallback = z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value)
        return (
          url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.search && url.href === value
        )
      } catch {
        return false
      }
    }, "An exact HTTPS callback without credentials, query or fragment is required")
  export const Client = z
    .discriminatedUnion("kind", [
      z.strictObject({ clientID: Identity.ID, kind: z.literal("web"), redirectUri: webCallback }),
      z.strictObject({
        clientID: Identity.ID,
        kind: z.literal("desktop"),
        redirectUri: z.literal("synergy://organization-auth/callback"),
      }),
    ])
    .meta({ ref: "OrgAuthClient" })
  export type Client = z.infer<typeof Client>
  export const Authority = z.strictObject({ issuer: Origin, orgID: Identity.ID, deploymentIncarnation: Identity.ID })
  export const Discovery = Authority.extend({ client: Client, codeChallengeMethod: z.literal("S256") }).meta({
    ref: "OrgAuthDiscovery",
  })
  export const Authorize = Authority.extend({
    clientID: Identity.ID,
    redirectUri: z.string().max(2048),
    state: z
      .string()
      .min(32)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
    codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    codeChallengeMethod: z.literal("S256"),
  }).meta({ ref: "OrgAuthorizeInput" })
  export type Authorize = z.infer<typeof Authorize>
  export const Code = Authority.extend({
    clientID: Identity.ID,
    redirectUri: z.string(),
    state: Authorize.shape.state,
    code: Identity.Token,
    expiresAt: z.number().int(),
  }).meta({ ref: "OrgAuthorizationCode" })
  export const Exchange = Authority.extend({
    clientID: Identity.ID,
    redirectUri: z.string().max(2048),
    code: Identity.Token,
    verifier: z
      .string()
      .min(43)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/),
  }).meta({ ref: "OrgCodeExchangeInput" })
  export type Exchange = z.infer<typeof Exchange>
  export const Refresh = Authority.extend({ clientID: Identity.ID, refreshToken: Identity.Token }).meta({
    ref: "OrgTokenRefreshInput",
  })
  export type Refresh = z.infer<typeof Refresh>
  export const Tokens = Authority.extend({
    clientID: Identity.ID,
    account: Identity.Account,
    tokenType: z.literal("Bearer"),
    accessToken: Identity.Token,
    expiresAt: z.number().int(),
    refreshToken: Identity.Token.optional(),
    refreshExpiresAt: z.number().int().optional(),
  }).meta({ ref: "OrgClientTokens" })
}
